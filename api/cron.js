import fetch from "node-fetch";
import { facebook } from "datakund";
import winston from "winston";
import dotenv from "dotenv";
import fs from "fs";
import chrome from "chrome-aws-lambda";

// إعداد تسجيل الأخطاء
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

// إعداد متغيرات البيئة
dotenv.config();
const API_URL = "https://api.shapes.inc/v1";
const MODEL = "shapesinc/orind";
const API_KEY = process.env.API_KEY;
const PAGE_ID = process.env.PAGE_ID;
const COOKIES_PATH = "./fb_cookies.json";

// إعداد الكوكيز
const FB_CREDENTIALS = {
  cookies: fs.existsSync(COOKIES_PATH) ? JSON.parse(fs.readFileSync(COOKIES_PATH)) : null,
  chromePath: chrome.executablePath, // إضافة مسار Chrome من chrome-aws-lambda
};

// إعادة المحاولة في حالة الفشل
async function withRetry(fn, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      logger.warn(`Retrying... Attempt ${i + 1} failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function generateSinglePost() {
  return withRetry(async () => {
    const resp = await fetch(`${API_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
        "X-Channel-ID": "Facebook",
        "X-User-ID": "Facebook-Posts",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "اكتب لي منشور قصير للصفحة: جملة أو جملتين." }],
      }),
    });
    if (!resp.ok) throw new Error(`API call failed: ${resp.status}`);
    const data = await resp.json();
    const text = data.choices[0].message.content.split(/\r?\n/)[0].trim();
    return text || "منشور افتراضي";
  });
}

async function generatePostContent() {
  const post1 = await generateSinglePost();
  const post2 = await generateSinglePost();
  return [post1, post2];
}

async function publishNewPost(message) {
  return withRetry(async () => {
    try {
      const result = await facebook.facebook__auto__post({
        page_id: PAGE_ID,
        message: message,
        credentials: FB_CREDENTIALS,
      });
      logger.info(`Published post: ${message}`);
      return { success: true, message, result };
    } catch (error) {
      logger.error(`Failed to publish post: ${error.message}`);
      throw error;
    }
  });
}

async function getRecentComments(limit = 9) {
  return withRetry(async () => {
    try {
      const comments = await facebook.facebook__get__comments({
        page_id: PAGE_ID,
        limit: limit,
        credentials: FB_CREDENTIALS,
      });
      const formattedComments = comments.map((c) => ({
        comment_id: c.id || `temp_${Math.random()}`,
        message: c.message,
      }));
      logger.info(`Fetched ${formattedComments.length} comments`);
      return formattedComments;
    } catch (error) {
      logger.error(`Failed to fetch comments: ${error.message}`);
      throw error;
    }
  });
}

async function replyToComment(commentId, replyText) {
  return withRetry(async () => {
    try {
      const result = await facebook.facebook__auto__comment({
        comment_id: commentId,
        message: replyText,
        credentials: FB_CREDENTIALS,
      });
      logger.info(`Replied to comment ${commentId}: ${replyText}`);
      return { success: true, comment_id: commentId, reply: replyText, result };
    } catch (error) {
      logger.error(`Failed to reply to comment ${commentId}: ${error.message}`);
      throw error;
    }
  });
}

async function getRecentConversations(limit = 9) {
  return withRetry(async () => {
    try {
      const conversations = await facebook.facebook__get__conversations({
        page_id: PAGE_ID,
        limit: limit,
        credentials: FB_CREDENTIALS,
      });
      const formattedConversations = conversations.map((c) => ({
        thread_id: c.id || `temp_${Math.random()}`,
        sender_id: c.from_id || "unknown",
        message: c.message,
      }));
      logger.info(`Fetched ${formattedConversations.length} conversations`);
      return formattedConversations;
    } catch (error) {
      logger.error(`Failed to fetch conversations: ${error.message}`);
      throw error;
    }
  });
}

async function sendDM(recipientId, text) {
  return withRetry(async () => {
    try {
      const result = await facebook.facebook__auto__message({
        recipient_id: recipientId,
        message: text,
        credentials: FB_CREDENTIALS,
      });
      logger.info(`Sent DM to ${recipientId}: ${text}`);
      return { success: true, recipient_id: recipientId, text, result };
    } catch (error) {
      logger.error(`Failed to send DM to ${recipientId}: ${error.message}`);
      throw error;
    }
  });
}

async function generateAIReplyForText(userText) {
  return withRetry(async () => {
    const resp = await fetch(`${API_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
        "X-Channel-ID": "Facebook",
        "X-User-ID": "Facebook-Posts",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: userText }],
      }),
    });
    if (!resp.ok) throw new Error(`API call failed: ${resp.status}`);
    const data = await resp.json();
    return data.choices[0].message.content.split(/\r?\n/)[0].trim() || "عذراً، لا يمكنني الرد الآن.";
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    logger.error(`Method ${req.method} not allowed`);
    return res.status(405).send("Method Not Allowed");
  }

  let callsRemaining = 20;
  const log = [];

  try {
    // التحقق من وجود الكوكيز
    if (!FB_CREDENTIALS.cookies) {
      logger.error("Cookies file not found or invalid");
      return res.status(500).json({ error: "Cookies file not found or invalid" });
    }

    // نشر منشورات
    if (callsRemaining >= 2) {
      const [post1, post2] = await generatePostContent();
      const pub1 = await publishNewPost(post1);
      log.push({ action: "publishPost", post: post1, result: pub1 });
      callsRemaining -= 1;
      const pub2 = await publishNewPost(post2);
      log.push({ action: "publishPost", post: post2, result: pub2 });
      callsRemaining -= 1;
    }

    // الرد على التعليقات
    if (callsRemaining > 0) {
      const maxComments = Math.min(9, callsRemaining);
      const commentBatch = await getRecentComments(maxComments);
      for (const c of commentBatch) {
        if (callsRemaining <= 0) break;
        const aiReply = await generateAIReplyForText(c.message);
        const replyData = await replyToComment(c.comment_id, aiReply);
        log.push({ action: "replyComment", comment_id: c.comment_id, reply: aiReply, result: replyData });
        callsRemaining -= 1;
      }
    }

    // الرد على الرسائل المباشرة
    if (callsRemaining > 0) {
      const maxDMs = Math.min(9, callsRemaining);
      const convBatch = await getRecentConversations(maxDMs);
      for (const c of convBatch) {
        if (callsRemaining <= 0) break;
        const aiReply = await generateAIReplyForText(c.message);
        const dmData = await sendDM(c.sender_id, aiReply);
        log.push({ action: "replyDM", user_id: c.sender_id, reply: aiReply, result: dmData });
        callsRemaining -= 1;
      }
    }

    logger.info("Request completed successfully");
    return res.status(200).json({ timestamp: new Date().toISOString(), callsRemaining, log });
  } catch (error) {
    logger.error(`Request failed: ${error.message}`);
    return res.status(500).json({ error: "Internal Server Error", message: error.message });
  }
}
