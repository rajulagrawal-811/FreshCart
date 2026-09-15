const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "";

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 1000000) {
        req.destroy();
        reject(new Error("Request too large"));
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function clean(value, max = 160) {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, max);
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(
    String(email || "").trim()
  );
}

/* ================= EMAIL ================= */

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    throw new Error("Resend API key is not configured on the server.");
  }

  if (!RESEND_FROM) {
    throw new Error("RESEND_FROM is not configured on the server.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject,
      html
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("Resend error:", response.status, data);

    throw new Error(
      data.message ||
      data.error ||
      `Resend rejected the email (${response.status}).`
    );
  }

  return data;
}

/* ================= OTP ================= */

const otpStore = new Map();

const OTP_TTL = 10 * 60 * 1000;
const OTP_COOLDOWN = 60 * 1000;
const MAX_ATTEMPTS = 5;

async function handleSendOtp(req, res) {
  try {
    const body = await readBody(req);

    const email = String(body.email || "")
      .trim()
      .toLowerCase();

    if (!validEmail(email)) {
      return sendJson(res, 400, {
        success: false,
        message: "Please enter a valid email address."
      });
    }

    const old = otpStore.get(email);

    if (old && Date.now() - old.sentAt < OTP_COOLDOWN) {
      const wait = Math.ceil(
        (OTP_COOLDOWN - (Date.now() - old.sentAt)) / 1000
      );

      return sendJson(res, 429, {
        success: false,
        message: `Please wait ${wait} seconds before requesting another OTP.`
      });
    }

    /* TEMPORARY OTP */
    const otp = "123456";

    otpStore.set(email, {
      otp,
      sentAt: Date.now(),
      expiresAt: Date.now() + OTP_TTL,
      attempts: 0
    });

    console.log(`[TEMP OTP] ${email} -> 123456`);

    return sendJson(res, 200, {
      success: true,
      message: "Temporary OTP generated. Use 123456 to continue.",
      temporaryOtp: "123456"
    });

  } catch (error) {
    console.error("OTP SEND ERROR:", error);

    return sendJson(res, 500, {
      success: false,
      message: error.message || "Unable to generate OTP."
    });
  }
}

async function handleVerifyOtp(req, res) {
  try {
    const body = await readBody(req);

    const email = String(body.email || "")
      .trim()
      .toLowerCase();

    const otp = String(body.otp || "").trim();

    if (!validEmail(email) || !/^\d{6}$/.test(otp)) {
      return sendJson(res, 400, {
        success: false,
        message: "Invalid or expired OTP."
      });
    }

    const record = otpStore.get(email);

    if (!record) {
      return sendJson(res, 400, {
        success: false,
        message: "OTP expired or not found. Please request a new OTP."
      });
    }

    if (Date.now() > record.expiresAt) {
      otpStore.delete(email);

      return sendJson(res, 400, {
        success: false,
        message: "OTP expired. Please request a new one."
      });
    }

    if (record.attempts >= MAX_ATTEMPTS) {
      otpStore.delete(email);

      return sendJson(res, 429, {
        success: false,
        message: "Too many attempts. Please request a new OTP."
      });
    }

    record.attempts++;

    if (otp !== record.otp) {
      return sendJson(res, 400, {
        success: false,
        message: "Incorrect OTP. Please try again."
      });
    }

    otpStore.delete(email);

    console.log(`[OTP VERIFIED] ${email}`);

    return sendJson(res, 200, {
      success: true,
      email
    });

  } catch (error) {
    console.error("OTP VERIFY ERROR:", error);

    return sendJson(res, 500, {
      success: false,
      message: "Unable to verify OTP."
    });
  }
}

/* ================= ORDER EMAIL ================= */

function buildOrderEmail(order) {
  const items = (order.items || [])
    .map(item => `
      <tr>
        <td style="padding:10px;border-bottom:1px solid #eee">
          ${clean(item.name, 80)}
        </td>

        <td style="padding:10px;border-bottom:1px solid #eee;text-align:center">
          ${Number(item.quantity) || 0}
        </td>

        <td style="padding:10px;border-bottom:1px solid #eee;text-align:right">
          ₹${Number(item.price || 0).toFixed(2)}
        </td>
      </tr>
    `)
    .join("");

  const address = order.address || {};

  return {
    subject: `FreshCart Order Confirmed — ${clean(order.orderId, 30)}`,

    html: `
      <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;padding:24px;color:#222">

        <h1>🛒 FreshCart</h1>

        <p style="font-size:18px">
          Your order has been confirmed! 🎉
        </p>

        <div style="background:#f5fff8;padding:16px;border-radius:12px;margin:18px 0">

          <b>Order ID:</b>
          ${clean(order.orderId,30)}
          <br>

          <b>Payment:</b>
          ${clean(order.payment,60)}
          <br>

          <b>Total:</b>
          ₹${Number(order.total || 0).toFixed(2)}

        </div>

        <h3>Items</h3>

        <table style="width:100%;border-collapse:collapse">

          <thead>
            <tr>
              <th style="text-align:left;padding:10px">Item</th>
              <th>Qty</th>
              <th style="text-align:right">Price</th>
            </tr>
          </thead>

          <tbody>
            ${items}
          </tbody>

        </table>

        <h3>Delivery Address</h3>

        <p>
          ${clean(order.customer?.name,80)}
          <br>
          ${clean(address.house,120)}, ${clean(address.area,120)}
          <br>
          ${clean(address.city,80)}, ${clean(address.state,80)}
          - ${clean(address.pincode,10)}
        </p>

        <p style="margin-top:28px">
          Thank you for shopping with FreshCart ❤️
        </p>

      </div>
    `
  };
}

/* ================= STATIC FILES ================= */

function serveStatic(req, res) {
  let pathname = decodeURIComponent(req.url.split("?")[0]);

  if (pathname === "/") {
    pathname = "/index.html";
  }

  const safePath = path.normalize(
    path.join(ROOT, pathname)
  );

  if (!safePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
      });

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
      "Content-Type":
        types[ext] || "application/octet-stream"
    });

    res.end(data);
  });
}

/* ================= SERVER ================= */

const server = http.createServer(async (req, res) => {

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });

    return res.end();
  }

  if (
    req.method === "POST" &&
    req.url === "/api/send-otp"
  ) {
    return handleSendOtp(req, res);
  }

  if (
    req.method === "POST" &&
    req.url === "/api/verify-otp"
  ) {
    return handleVerifyOtp(req, res);
  }

  if (
    req.method === "POST" &&
    req.url === "/api/order"
  ) {
    try {
      const order = await readBody(req);

      if (!/^[A-Z0-9-]{4,30}$/.test(
        String(order.orderId || "")
      )) {
        return sendJson(res, 400, {
          success: false,
          message: "Invalid order ID"
        });
      }

      const mobile = String(
        order.customer?.mobile || ""
      );

      if (!/^[6-9]\d{9}$/.test(mobile)) {
        return sendJson(res, 400, {
          success: false,
          message: "Invalid Indian mobile number"
        });
      }

      const email = String(
        order.customer?.email || ""
      ).trim();

      if (!validEmail(email)) {
        return sendJson(res, 400, {
          success: false,
          message: "Invalid email address"
        });
      }

      if (
        !Array.isArray(order.items) ||
        order.items.length === 0
      ) {
        return sendJson(res, 400, {
          success: false,
          message: "Cart is empty"
        });
      }

      const emailInfo = buildOrderEmail(order);

      const result = await sendEmail({
        to: email,
        subject: emailInfo.subject,
        html: emailInfo.html
      });

      console.log(
        `[ORDER EMAIL SENT] ${order.orderId} → ${email}`
      );

      return sendJson(res, 200, {
        success: true,
        orderId: order.orderId,
        emailSent: true,
        emailId: result.id || null,
        message: "Order placed and confirmation email sent."
      });

    } catch (error) {
      console.error("ORDER ERROR:", error);

      return sendJson(res, 500, {
        success: false,
        message: error.message || "Unable to place order"
      });
    }
  }

  if (
    req.method === "GET" &&
    req.url === "/api/health"
  ) {
    return sendJson(res, 200, {
      success: true,
      resendConfigured: Boolean(
        RESEND_API_KEY && RESEND_FROM
      )
    });
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(
    `FreshCart running on port ${PORT}`
  );

  console.log(
    "Resend:",
    RESEND_API_KEY && RESEND_FROM
      ? "configured"
      : "NOT configured"
  );
});
