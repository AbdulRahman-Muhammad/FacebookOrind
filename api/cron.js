// api/cron.js
const fetch = require('node-fetch');
const { FacebookPrivate } = require('facebook-private-api');
const { device, storage } = require('fbjs-skm');

const API_URL = 'https://api.shapes.inc/v1';
const MODEL = 'shapesinc/orind';
const API_KEY = process.env.API_KEY;
const FB_EMAIL = process.env.FB_EMAIL;
const FB_PASS = process.env.FB_PASS;
const PAGE_ID = process.env.PAGE_ID;

async function generateAI(text) {
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
      messages: [{ role: "user", content: text }]
    })
  });
  const data = await resp.json();
  return data.choices[0].message.content.split(/\r?\n/)[0].trim();
}

async function main() {
  const fb = new FacebookPrivate({ device, storage });
  await fb.login(FB_EMAIL, FB_PASS);

  let calls = 20;
  const log = [];

  if (calls >= 2) {
    const p1 = await generateAI("اكتب لي منشور قصير للصفحة: جملة أو جملتين.");
    await fb.page.post({ page_id: PAGE_ID, text: p1 });
    log.push({ action: "publishPost", post: p1 });
    calls -= 1;
    const p2 = await generateAI("اكتب لي منشور قصير للصفحة: جملة أو جملتين.");
    await fb.page.post({ page_id: PAGE_ID, text: p2 });
    log.push({ action: "publishPost", post: p2 });
    calls -= 1;
  }

  if (calls > 0) {
    const posts = await fb.page.list({ page_id: PAGE_ID, limit: 3, request_type: 'feed' });
    let count = 0;
    for (const post of posts.data) {
      if (count >= Math.min(9, calls)) break;
      const comments = await fb.post.getComments({ post_id: post.id, limit: Math.min(9 - count, calls) });
      for (const c of comments.data) {
        if (count >= Math.min(9, calls)) break;
        const reply = await generateAI(c.message);
        await fb.comment.reply({ comment_id: c.id, message: reply });
        log.push({ action: "replyComment", comment_id: c.id });
        calls -= 1;
        count += 1;
      }
    }
  }

  if (calls > 0) {
    const threads = await fb.thread.list({ limit: calls * 2 });
    let count = 0;
    for (const t of threads.data) {
      if (count >= Math.min(9, calls)) break;
      if (t.messages_unread > 0 && !t.is_spam) {
        const msg = await fb.thread.getMessages({ thread_id: t.id, limit: 1 });
        const last = msg.data[0];
        if (last.from !== fb.getUserID()) {
          const reply = await generateAI(last.body);
          await fb.message.send({ thread_id: t.id, message: { text: reply } });
          log.push({ action: "replyDM", thread_id: t.id });
          calls -= 1;
          count += 1;
        }
      }
    }
  }

  return { timestamp: new Date().toISOString(), callsRemaining: calls, log };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).send("Method Not Allowed");
  }
  try {
    const result = await main();
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
