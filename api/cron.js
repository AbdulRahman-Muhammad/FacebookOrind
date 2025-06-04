import fetch from "node-fetch";
import puppeteer from "puppeteer";
import winston from "winston";
import dotenv from "dotenv";

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
const FB_CREDENTIALS = {
  email: process.env.FB_EMAIL,
  password: process.env.FB_PASSWORD,
};

// إعداد Puppeteer
async function launchBrowser() {
  return await puppeteer.launch({
    headless: true, // تشغيل بدون واجهة للـ production
    args: ["--no-sandbox", "--disable-setuid-sandbox"], // تحسين الأداء
  });
}

// إعادة المحاولة في حالة الفشل
async function withRetry(fn, retries = 3, delay = 1000) {
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
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.goto("https://www.facebook.com", { waitUntil: "networkidle2" });

      // تسجيل الدخول
      await page.type("#email", FB_CREDENTIALS.email);
      await page.type("#pass", FB_CREDENTIALS.password);
      await page.click('button[name="login"]');
      await page.waitForNavigation({ waitUntil: "networkidle2" });

      // الانتقال للصفحة
      await page.goto(`https://www.facebook.com/${PAGE_ID}`, { waitUntil: "networkidle2" });

      // كتابة المنشور
      await page.click('div[role="button"][aria-label*="اكتب منشورًا"]');
      await page.waitForSelector('div[role="textbox"]');
      await page.type('div[role="textbox"]', message);
      await page.click('button[aria-label="نشر"]');
      await page.waitForTimeout(2000); // انتظار تأكيد النشر

      logger.info(`Published post: ${message}`);
      return { success: true, message };
    } catch (error) {
      logger.error(`Failed to publish post: ${error.message}`);
      throw error;
    } finally {
      await browser.close();
    }
  });
}

async function getRecentComments(limit = 9) {
  return withRetry(async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.goto(`https://www.facebook.com/${PAGE_ID}/posts`, { waitUntil: "networkidle2" });

      // جلب التعليقات
      const comments = await page.evaluate((limit) => {
        const commentElements = document.querySelectorAll('div[role="article"] span[dir="auto"]');
        return Array.from(commentElements)
          .slice(0, limit)
          .map((el) => ({
            comment_id: el.closest('div[role="article"]')?.id || "unknown",
            message: el.textContent.trim(),
          }));
      }, limit);

      logger.info(`Fetched ${comments.length} comments`);
      return comments;
    } catch (error) {
      logger.error(`Failed to fetch comments: ${error.message}`);
      throw error;
    } finally {
      await browser.close();
    }
  });
}

async function replyToComment(commentId, replyText) {
  return withRetry(async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.goto(`https://www.facebook.com/${PAGE_ID}`, { waitUntil: "networkidle2" });

      // الرد على تعليق
      await page.evaluate(
        (commentId, replyText) => {
          const commentBox = document.querySelector(`div[role="article"][id="${commentId}"] textarea`);
          if (commentBox) {
            commentBox.value = replyText;
            commentBox.dispatchEvent(new Event("input", { bubbles: true }));
            document.querySelector('button[aria-label="تعليق"]').click();
          }
        },
        commentId,
        replyText
      );
      await page.waitForTimeout(2000);

      logger.info(`Replied to comment ${commentId}: ${replyText}`);
      return { success: true, comment_id: commentId, reply: replyText };
    } catch (error) {
      logger.error(`Failed to reply to comment ${commentId}: ${error.message}`);
      throw error;
    } finally {
      await browser.close();
    }
  });
}

async function getRecentConversations(limit = 9) {
  return withRetry(async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.goto(`https://www.facebook.com/${PAGE_ID}/inbox`, { waitUntil: "networkidle2" });

      // جلب المحادثات
      const conversations = await page.evaluate((limit) => {
        const messages = document.querySelectorAll('div[role="row"] a[href*="/t/"]');
        return Array.from(messages)
          .slice(0, limit)
          .map((msg) => ({
            thread_id: msg.href.split("/t/")[1] || "unknown",
            sender_id: "unknown", // Puppeteer مش بيجيب sender_id بسهولة، ممكن تحتاج API إضافي هنا
            message: msg.textContent.trim(),
          }));
      }, limit);

      logger.info(`Fetched ${conversations.length} conversations`);
      return conversations;
    } catch (error) {
      logger.error(`Failed to fetch conversations: ${error.message}`);
      throw error;
    } finally {
      await browser.close();
    }
  });
}

async function sendDM(recipientId, text) {
  return withRetry(async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.goto(`https://www.facebook.com/messages/t/${recipientId}`, {
        waitUntil: "networkidle2",
      });

      // إرسال رسالة مباشرة
      await page.type('div[role="textbox"]', text);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(2000);

      logger.info(`Sent DM to ${recipientId}: ${text}`);
      return { success: true, recipient_id: recipientId, text };
    } catch (error) {
      logger.error(`Failed to send DM to ${recipientId}: ${error.message}`);
      throw error;
    } finally {
      await browser.close();
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
