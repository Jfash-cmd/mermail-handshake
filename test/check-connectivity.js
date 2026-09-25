require('dotenv').config();
const { createImapClient, createSmtpTransporter } = require('../vendor-bot.js');

async function checkConnectivity() {
  const user = process.env.VENDOR_GMAIL_ADDRESS;
  const pass = process.env.VENDOR_GMAIL_APP_PASSWORD;

  console.log(`Checking connection for: ${user}...`);

  // 1. Check SMTP
  console.log('Verifying SMTP connection...');
  const transporter = createSmtpTransporter(user, pass);
  await transporter.verify();
  console.log('✓ SMTP connection verified successfully!');

  // 2. Check IMAP
  console.log('Verifying IMAP connection...');
  let imapClient;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      imapClient = createImapClient(user, pass);
      await imapClient.connect();
      console.log('✓ IMAP connection established successfully!');
      break;
    } catch (connErr) {
      if (attempt === 3) throw connErr;
      console.warn(`IMAP connect attempt ${attempt}/3 failed (${connErr.message || connErr}). Retrying in 1.5s...`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const lock = await imapClient.getMailboxLock('INBOX');
  try {
    const status = await imapClient.status('INBOX', { unseen: true, messages: true });
    console.log(`✓ INBOX status: ${status.messages} total messages, ${status.unseen} unread.`);
  } finally {
    lock.release();
    await imapClient.logout();
    console.log('✓ IMAP logged out cleanly.');
  }
}

checkConnectivity()
  .then(() => {
    console.log('All connectivity checks passed!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Connectivity check failed:', err);
    process.exit(1);
  });
