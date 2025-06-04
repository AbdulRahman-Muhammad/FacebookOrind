import fetch from "node-fetch";

const API_URL = 'https://api.shapes.inc/v1';
const MODEL = 'shapesinc/orind';
const API_KEY = 'HV1YWAUTBSH8USNZOZ6DXX6BHX9K3YKLNPLKBC816E0';
const PAGE_TOKEN = 'EAA417ArZBgbEBO5qjpZBpzopB8RZATVZCQ9WLbDn4BuRkJRRF13fXe0g8timSW7w9jQ17WIOtTSQ4YoE2QxLxZBVAsffQjlqiheE7AZBkCwbUf2NxwW07oLFmpk2BxWGr9XaKeXrsTOrRKXmuLJvMDKbSoFQ0nC8inar0sNZAPZBfZCYRVMpQLU5msuVPZCefPDZAcFsgF0khrdj70rCKF7LZClgtsfYbctg';
const PAGE_ID = '604075112798536';
const GRAPH_BASE = `https://graph.facebook.com/v23.0`;

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
  const res = await fetch(`${GRAPH_BASE}/${PAGE_ID}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, access_token: PAGE_TOKEN })
  });
  return await res.json();
}

async function getRecentComments(limit = 9) {
  let comments = [];
  const postsRes = await fetch(`${GRAPH_BASE}/${PAGE_ID}/posts?limit=3&access_token=${PAGE_TOKEN}`);
  const postsData = await postsRes.json();
  for (const post of postsData.data) {
    if (comments.length >= limit) break;
    const toFetch = limit - comments.length;
    const commentsRes = await fetch(
      `${GRAPH_BASE}/${post.id}/comments?limit=${toFetch}&order=reverse_chronological&access_token=${PAGE_TOKEN}`
    );
    const cmts = await commentsRes.json();
    comments.push(...cmts.data.map(c => ({ comment_id: c.id, message: c.message })));
  }
  return comments.slice(0, limit);
}

async function replyToComment(commentId, replyText) {
  const res = await fetch(`${GRAPH_BASE}/${commentId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: replyText, access_token: PAGE_TOKEN })
  });
  return await res.json();
}

async function getRecentConversations(limit = 9) {
  let results = [];
  const convRes = await fetch(`${GRAPH_BASE}/${PAGE_ID}/conversations?limit=${limit}&access_token=${PAGE_TOKEN}`);
  const convData = await convRes.json();
  for (const conv of convData.data) {
    if (results.length >= limit) break;
    const msgsRes = await fetch(`${GRAPH_BASE}/${conv.id}/messages?limit=1&access_token=${PAGE_TOKEN}`);
    const msgsData = await msgsRes.json();
    const lastMsg = msgsData.data?.[0];
    if (lastMsg && lastMsg.from?.id !== PAGE_ID) {
      results.push({ thread_id: conv.id, sender_id: lastMsg.from.id, message: lastMsg.message });
    }
  }
  return results.slice(0, limit);
}

async function sendDM(recipientId, text) {
  const res = await fetch(`${GRAPH_BASE}/me/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text }, access_token: PAGE_TOKEN })
  });
  return await res.json();
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
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).send("Method Not Allowed");

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
