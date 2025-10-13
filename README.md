# MSSQL -> LINE Monitor

This small Node.js script polls an MS SQL table for new rows and pushes messages via the LINE Push API.

1. Copy `.env.example` to `.env` and fill values (MS SQL credentials, LINE channel token, and target user/group id).

2. Install dependencies:

```powershell
npm install
```

3. Run the monitor:

```powershell
npm start
```

Configuration options are in `.env` and include `POLL_INTERVAL`, `ID_COLUMN`, optional `TIME_COLUMN`, and `MESSAGE_TEMPLATE`.

MESSAGE_TEMPLATE supports placeholders like `{{id}}`, `{{name}}`, etc. based on your table columns.

Notes:
- This is a simple poller and not production-grade. For larger scale or guarantees, consider change data capture, triggers, or service broker.
- The LINE Push API requires the channel access token and the target user or group ID (to push to groups obtain the group id after inviting the bot).