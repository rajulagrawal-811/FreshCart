/*
  FreshCart Email + static server
  Requires Node.js 18+.
  No npm packages required.

  Windows PowerShell example:
    $env:RESEND_API_KEY="re_xxxxxxxxxxxxxxxx"
    $env:RESEND_FROM="FreshCart <onboarding@resend.dev>"
    node server.js

  Then open:
    http://localhost:3000

  IMPORTANT:
  Never put the Resend API key in index.html. Use environment variables.
*/

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "FreshCart <onboarding@resend.dev>";

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function clean(value, max = 160) {
  return String(value ?? "").replace(/[<>]/g, "").trim().slice(0, max);
}

function buildEmail(order) {
  const items = (order.items || []).map(item =>
    `<tr><td style="padding:10px;border-bottom:1px solid #eee">${clean(item.name,80)}</td><td style="padding:10px;border-bottom:1px solid #eee;text-align:center">${Number(item.quantity)||0}</td><td style="padding:10px;border-bottom:1px solid #eee;text-align:right">₹${Number(item.price||0).toFixed(2)}</td></tr>`
  ).join("");

  const address = order.address || {};
  return {
    subject: `FreshCart Order Confirmed — ${clean(order.orderId,30)}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;padding:24px;color:#222">
        <h1 style="margin-bottom:4px">🛒 FreshCart</h1>
        <p style="font-size:18px">Your order has been confirmed! 🎉</p>
        <div style="background:#f5fff8;padding:16px;border-radius:12px;margin:18px 0">
          <b>Order ID:</b> ${clean(order.orderId,30)}<br>
          <b>Payment:</b> ${clean(order.payment,60)}<br>
          <b>Total:</b> ₹${Number(order.total||0).toFixed(2)}
        </div>
        <h3>Items</h3>
        <table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left;padding:10px">Item</th><th>Qty</th><th style="text-align:right">Price</th></tr></thead><tbody>${items}</tbody></table>
        <h3>Delivery Address</h3>
        <p>${clean(order.customer?.name,80)}<br>${clean(address.house,120)}, ${clean(address.area,120)}<br>${clean(address.city,80)}, ${clean(address.state,80)} - ${clean(address.pincode,10)}</p>
        <p style="margin-top:28px">Thank you for shopping with FreshCart ❤️</p>
      </div>`
  };
}

async function sendResendEmail(to, order) {
  if (!RESEND_API_KEY) {
    return { sent:false, reason:"Resend API key is not configured." };
  }

  const email = buildEmail(order);
  const response = await fetch("https://api.resend.com/emails", {
    method:"POST",
    headers:{
      "Authorization":`Bearer ${RESEND_API_KEY}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      from:RESEND_FROM,
      to:[to],
      subject:email.subject,
      html:email.html
    })
  });

  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.message || "Email sending failed");
  return {sent:true,id:data.id};
}

function serveStatic(req, res) {
  let pathname = decodeURIComponent(req.url.split("?")[0]);

  if (pathname === "/") pathname = "/index.html";

  const safePath = path.normalize(path.join(ROOT, pathname));
  if (!safePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }

    const ext = path.extname(safePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml"
    };

    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream"
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  if (req.method === "POST" && req.url === "/api/order") {
    try {
      const order = await readBody(req);

      if (!/^[A-Z0-9-]{4,30}$/.test(String(order.orderId || ""))) {
        return sendJson(res, 400, {
          success: false,
          message: "Invalid order ID"
        });
      }

      const mobile = String(order.customer?.mobile || "");
      if (!/^[6-9]\d{9}$/.test(mobile)) {
        return sendJson(res, 400, { success:false, message:"Invalid Indian mobile number" });
      }

      const email = String(order.customer?.email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return sendJson(res, 400, { success:false, message:"Invalid email address" });
      }

      if (!Array.isArray(order.items) || order.items.length === 0) {
        return sendJson(res, 400, {
          success: false,
          message: "Cart is empty"
        });
      }

      const emailResult = await sendResendEmail(email, order);

      // Server log for development/order testing.
      console.log(
        `[ORDER ${new Date().toISOString()}]`,
        clean(order.orderId, 30),
        clean(order.customer?.name, 80),
        mobile,
        `Rs.${Number(order.total || 0).toFixed(2)}`,
        emailResult.sent ? "EMAIL SENT" : `EMAIL NOT SENT: ${emailResult.reason}`
      );

      return sendJson(res, 200, {
        success: true,
        orderId: order.orderId,
        emailSent: emailResult.sent,
        message: emailResult.sent
          ? "Order placed and confirmation email sent."
          : "Order placed, but email provider is not configured.",
        emailId: emailResult.id || null
      });

    } catch (error) {
      console.error(error);
      return sendJson(res, 500, {
        success: false,
        message: error.message || "Unable to place order"
      });
    }
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`FreshCart running at http://localhost:${PORT}`);
  console.log("Email:", RESEND_API_KEY && RESEND_FROM
    ? "Resend configured"
    : "Resend NOT configured");
});
