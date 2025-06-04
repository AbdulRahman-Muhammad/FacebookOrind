import fetch from "node-fetch";
import { Facebook } from "facebook-unofficial-api";

const API_URL    = 'https://api.shapes.inc/v1';
const MODEL      = 'shapesinc/orind';
const API_KEY    = 'HV1YWAUTBSH8USNZOZ6DXX6BHX9K3YKLNPLKBC816E0';
const FB_EMAIL   = 'your_email@example.com';
const FB_PASS    = 'your_password';
const PAGE_ID    = '604075112798536';
let fb; // سنخزن كائن Facebook هنا بعد تسجيل الدخول

async function initFacebook() {
  fb = new Facebook();
  await fb.login(FB_EMAIL, FB_PASS);
}

async function generateSinglePost() {
  const resp = await fetch(`${API_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
      "X-Channel-ID": "Facebook",
      "X-User-ID": "Facebook-Posts"
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "user", content: "اكتب لي منشور قصير للصفحة: جملة أو جملتين." }
      ]
    })
  });
  const data = await resp.json();
  const text = data.choices[0].message.content.split(/\r?\n/)[0].trim();
  return text || "منشور افتراضي";
}

async function generatePostContent() {
  const post1 = await generateSinglePost();
  const post2 = await generateSinglePost();
  return [post1, post2];
}

async function publishNewPost(message) {
  return await fb.post(message, PAGE_ID);
}

async function getRecentComments(limit = 9) {
  const allComments = [];
  // جلب أحدث 3 منشورات من الصفحة
  const posts = await fb.getPosts(PAGE_ID, { limit: 3 });
  for (const post of posts) {
    if (allComments.length >= limit) break;
    // جلب التعليقات من كل منشور
    const comments = await fb.getComments(post.id, { limit: limit - allComments.length });
    for (const c of comments) {
      allComments.push({ comment_id: c.id, message: c.message });
      if (allComments.length >= limit) break;
    }
  }
  return allComments.slice(0, limit);
}

async function replyToComment(commentId, replyText) {
  return await fb.comment(commentId, replyText);
}

async function getRecentConversations(limit = 9) {
  const convs = [];
  const threads = await fb.getInbox({ limit });
  for (const thread of threads) {
    if (thread.unreadCount > 0) {
      const lastMsg = thread.messages.items.slice(-1)[0];
      if (lastMsg && lastMsg.from.id !== fb.userId) {
        convs.push({
          thread_id: thread.id,
          sender_id: lastMsg.from.id,
          message: lastMsg.body
        });
      }
      if (convs.length >= limit) break;
    }
  }
  return convs.slice(0, limit);
}

async function sendDM(recipientId, text) {
  return await fb.sendMessageToUser(recipientId, text);
}

async function generateAIReplyForText(userText) {
  const resp = await fetch(`${API_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
      "X-Channel-ID": "Facebook",
      "X-User-ID": "Facebook-Posts"
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "user", content: userText }
      ]
    })
  });
  const data = await resp.json();
  return data.choices[0].message.content.split(/\r?\n/)[0].trim() || "عذراً، لا يمكنني الرد الآن.";
}

export default async function handler(req, res) {
  if (!fb) {
    await initFacebook();
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  let callsRemaining = 20;
  const log = [];

  if (callsRemaining >= 2) {
    const [post1, post2] = await generatePostContent();
    const pub1 = await publishNewPost(post1);
    log.push({ action: "publishPost", post: post1, result: pub1 });
    callsRemaining -= 1;
    const pub2 = await publishNewPost(post2);
    log.push({ action: "publishPost", post: post2, result: pub2 });
    callsRemaining -= 1;
  }

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

  return res.status(200).json({ timestamp: new Date().toISOString(), callsRemaining, log });
}
