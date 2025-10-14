const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

module.exports = {
  mssql: {
    host: process.env.MSSQL_HOST || 'localhost',
    port: parseInt(process.env.MSSQL_PORT || '1433', 10),
    user: process.env.MSSQL_USER || 'sa',
    password: process.env.MSSQL_PASSWORD || '',
    database: process.env.MSSQL_DATABASE || 'master',
    table: process.env.MSSQL_TABLE || 'YourTableName',
    idColumn: process.env.ID_COLUMN || 'id',
    timeColumn: process.env.TIME_COLUMN || null,
    filterClause: process.env.FILTER_CLAUSE || null,
  },
  // Optional separate database for user subscriptions (defaults to 'user_data')
  userDb: {
    host: process.env.MSSQL_HOST || 'localhost',
    port: parseInt(process.env.MSSQL_PORT || '1433', 10),
    user: process.env.MSSQL_USER || 'sa',
    password: process.env.MSSQL_PASSWORD || '',
    database: process.env.USER_DATA_DATABASE || 'user_data',
    options: {
      encrypt: process.env.USER_DB_ENCRYPT === 'true'
    }
  },
  pollIntervalSec: parseInt(process.env.POLL_INTERVAL || '10', 10),
  line: {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || '',
    messageTemplate: process.env.MESSAGE_TEMPLATE || 'New record: {{id}}',
  }
  ,
  // Optional initial override for lastSeenId (useful for testing). If provided, will be used instead
  // of querying the DB for the current max id. Keep as string — caller can coerce type as needed.
  initialLastSeen: process.env.INITIAL_LAST_SEEN || null,
  // Column that contains the signal to check (e.g., Trade_Signal)
  signalColumn: process.env.SIGNAL_COLUMN || 'Trade_Signal',
  // LINE send control
  sendDelayMs: parseInt(process.env.SEND_DELAY_MS || '200', 10),
  lineMaxRetries: parseInt(process.env.LINE_MAX_RETRIES || '5', 10),
  lineRetryBaseMs: parseInt(process.env.LINE_RETRY_BASE_MS || '500', 10),
};
