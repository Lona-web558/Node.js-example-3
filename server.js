const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 8080;

// ==========================================
// SECURITY CONFIGURATION & VOLATILE MEMORY STORE
// ==========================================
// 256-bit Key and 16-byte Initialization Vector (Simulating HSM / KMS integration)
const CRYPTO_KEY = crypto.scryptSync(process.env.ENCRYPTION_SECRET || 'system-hsm-master-key-seed', 'salt', 32);

const TRANSACTION_LEDGER = []; // Stores secure encrypted transaction reference states

// Mock Central Clearing Bank Registry Database
const BANK_REGISTRY = {
  '4111': { status: 'APPROVED', code: '00', balanceCentsUSD: 50000 },
  '5105': { status: 'DECLINED', code: '51', balanceCentsUSD: 15 },
};

// Mock Real-time Treasury Interbank FX Currency Rates against Base Currency (USD)
const INTERBANK_FX_RATES = {
  USD: 1.0,
  EUR: 0.92, // 1 USD = 0.92 EUR
  GBP: 0.78, // 1 USD = 0.78 GBP
  ZAR: 18.25 // 1 USD = 18.25 ZAR
};

// ==========================================
// 1. AES-256-GCM FIELD LEVEL TOKENIZATION
// ==========================================
function encryptCardField(plainText) {
  const iv = crypto.randomBytes(12); // GCM standard recommendation length
  const cipher = crypto.createCipheriv('aes-256-gcm', CRYPTO_KEY, iv);
  
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  
  // Return composite token bundle packet
  return {
    iv: iv.toString('hex'),
    encryptedData: encrypted,
    authTag: authTag
  };
}

function decryptCardField(tokenBundle) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm', 
    CRYPTO_KEY, 
    Buffer.from(tokenBundle.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tokenBundle.authTag, 'hex'));
  
  let decrypted = decipher.update(tokenBundle.encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ==========================================
// 2. LUHN ALGORITHM CHECK PROCESSOR
// ==========================================
function validateLuhn(cardNumberString) {
  const digits = cardNumberString.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let shouldDouble = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

// ==========================================
// 3. ASYNCHRONOUS BATCH SETTLEMENT COMPILER
// ==========================================
function generateNachaBatchFile(transactions) {
  const creationDate = new Date().toISOString().slice(2, 10).replace(/-/g, ''); // YYMMDD
  const creationTime = new Date().toTimeString().slice(0, 5).replace(/:/g, ''); // HHMM

  let fileHeader = `101 021000021 123456789${creationDate}${creationTime}A094101MOCK GATEWAY DEPOSIT   \n`;
  let batchHeader = `5200MOCK ORIGINATOR    0001234567PPDRETAIL SETTL${creationDate}${creationDate}0001021000020000001\n`;
  
  let entryDetailRecords = '';
  let totalSettlementAmountCentsUSD = 0;
  let entryCount = 0;

  transactions.forEach((tx, index) => {
    entryCount++;
    totalSettlementAmountCentsUSD += tx.amountCentsUSD;
    
    // DECRYPTION ON THE FLY: Safely decrypt account identifier details for secure bank payload compilation
    const clearPAN = decryptCardField(tx.secureCardToken);
    const maskedAccountToken = clearPAN.slice(-4).padStart(10, 'X');
    
    const traceNumber = String(102000010000000 + index).padStart(15, '0');
    const amountStr = String(tx.amountCentsUSD).padStart(10, '0');
    
    entryDetailRecords += `622021000021${maskedAccountToken}${amountStr}TX-${tx.txId}     MERCHANT CAPTURE    0${traceNumber}\n`;
  });

  const totalAmountStr = String(totalSettlementAmountCentsUSD).padStart(12, '0');
  let batchControl = `8200${String(entryCount).padStart(6, '0')}0021000021000000000000${totalAmountStr}0001234567                         021000020000001\n`;
  let fileControl = `9000001${String(Math.ceil((entryCount + 4) / 10)).padStart(6, '0')}${String(entryCount).padStart(8, '0')}0021000021000000000000${totalAmountStr}                                       \n`;

  return `${fileHeader}${batchHeader}${entryDetailRecords}${batchControl}${fileControl}`;
}

// ==========================================
// HTTP SERVER GATEWAY INTERFACE INTERMEDIARY
// ==========================================
const server = http.createServer((req, res) => {
  // Serve Front-End Dashboard Console
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('Internal Gateway Cryptographic Engine Failure');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } 

  // Endpoint: Native FX Engine / Encryption Multi-Switch Terminal
  else if (req.method === 'POST' && req.url === '/gateway/v2/authorize') {
    let rawChunks = '';
    req.on('data', chunk => { rawChunks += chunk.toString(); });
    req.on('end', () => {
      try {
        const { cardNumber, expiry, cvv, amount, currency } = JSON.parse(rawChunks);
        const cleanCardNumber = cardNumber.replace(/\s+/g, '');

        // Step 1: Structural Algorithm Checksum Check
        if (!validateLuhn(cleanCardNumber)) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'REJECTED', responseCode: '14', message: 'Luhn error. Checksum mismatch.' }));
        }

        // Step 2: Dynamic Multicurrency FX Conversion Engine Normalization
        const transactionCurrency = (currency || 'USD').toUpperCase();
        const fxRate = INTERBANK_FX_RATES[transactionCurrency];
        
        if (!fxRate) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'REJECTED', responseCode: '03', message: 'Unsupported trading currency unit.' }));
        }

        const inputAmountCents = Math.round(parseFloat(amount) * 100);
        // Normalize input local currency value straight back to Base USD Cents to resolve clearing line tracking ledger allocations
        const amountCentsUSD = Math.round(inputAmountCents / fxRate);

        // Step 3: Secure AES-256-GCM Tokenization Phase
        const secureCardToken = encryptCardField(cleanCardNumber);

        // Step 4: Ledger Bin Prefix Validation & Funds Routing Verification
        const binPrefix = cleanCardNumber.substring(0, 4);
        const bankRoute = BANK_REGISTRY[binPrefix];

        if (!bankRoute || bankRoute.balanceCentsUSD < amountCentsUSD) {
          res.writeHead(402, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'DECLINED', responseCode: '51', message: 'Insufficient clear funds matching credit limit.' }));
        }

        // Save transaction to memory ledger with zero plain-text traces left behind
        const txId = crypto.randomBytes(6).toString('hex').toUpperCase();
        TRANSACTION_LEDGER.push({
          txId,
          amountCentsUSD,
          localCurrency: transactionCurrency,
          localAmountCents: inputAmountCents,
          secureCardToken, // Encrypted object tracking containing ciphertext, IV and Authentication Tag
          timestamp: new Date()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'SUCCESS',
          responseCode: '00',
          transactionReference: txId,
          conversionContext: {
            normalizedUSDAmount: `$${(amountCentsUSD / 100).toFixed(2)}`,
            conversionRateApplied: fxRate
          },
          tokenPreview: {
            ciphertext: secureCardToken.encryptedData.slice(0, 12) + "...",
            authTag: secureCardToken.authTag
          },
          message: 'Authorization Approved. Secure Token generated and stored safely in ledger memory database.'
        }));

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Switch Hardware Interoperability Cryptographic Glitch', details: err.message }));
      }
    });
  }

  // Endpoint: Asynchronous Batch Clearing Automation Dispatcher Link
  else if (req.method === 'POST' && req.url === '/gateway/v2/settle-batch') {
    if (TRANSACTION_LEDGER.length === 0) {
      res.writeHead(204, { 'Content-Type': 'application/json' });
      return res.end();
    }

    const itemsToClear = [...TRANSACTION_LEDGER];
    TRANSACTION_LEDGER.length = 0; // Empty ledger atomically

    const nachaFileContents = generateNachaBatchFile(itemsToClear);
    const fileName = `ACH_SECURE_BATCH_${Date.now()}.txt`;
    const filePath = path.join(__dirname, 'batches', fileName);

    if (!fs.existsSync(path.join(__dirname, 'batches'))) {
      fs.mkdirSync(path.join(__dirname, 'batches'));
    }

    fs.writeFile(filePath, nachaFileContents, (err) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'File-system stream batch synchronization log crash.' }));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'BATCH_DISPATCHED',
        clearingRecordCount: itemsToClear.length,
        outputFile: fileName,
        previewRawNachaLines: nachaFileContents.split('\n').slice(0, 3) // Return brief lines validation array snippet
      }));
    });
  }

  else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Route Not Found');
  }
});

