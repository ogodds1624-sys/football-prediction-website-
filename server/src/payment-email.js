import nodemailer from "nodemailer";
import { config } from "./config.js";

export const NIGERIA_PAYMENT_EMAIL = "andrewturkenterprise@gmail.com";

export async function sendNigeriaPaymentEmail(user, payment, plan) {
  if (!config.gmail.user || !config.gmail.appPassword) {
    throw new Error("Set GMAIL_USER and GMAIL_APP_PASSWORD to enable Nigerian payment emails.");
  }
  const transport = nodemailer.createTransport({
    service: "gmail",
    auth: { user: config.gmail.user, pass: config.gmail.appPassword },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  const lines = [
    "A Nigerian member submitted a payment receipt. Payment is not yet approved.",
    "",
    `Receipt ID: ${payment.id}`,
    `Member: ${user.name || user.email}`,
    `Email: ${user.email}`,
    `Plan: ${plan.name}`,
    `Amount: ${payment.currency} ${(payment.amount / 100).toFixed(2)}`,
    `Bank / network: ${payment.network}`,
    "",
    config.appUrl
      ? `Review the receipt in the Control Room: ${config.appUrl}/control-room.html#members`
      : "Open the Control Room's Members section to review the receipt.",
    "Verify the transfer before approving it. This email does not confirm that money was received.",
  ];
  const result = await transport.sendMail({
    from: config.gmail.user,
    to: NIGERIA_PAYMENT_EMAIL,
    subject: `New Nigerian payment receipt #${payment.id} - ${plan.name}`,
    text: lines.join("\n"),
  });
  if (!result.accepted?.some((address) => String(address).toLowerCase() === NIGERIA_PAYMENT_EMAIL)) {
    throw new Error("Gmail did not accept the payment notification recipient.");
  }
}
