/**
 * Google Apps Script for Bolna AI Workshop
 * 
 * This script integrates Google Sheets with Bolna AI to:
 * 1. Trigger calls to adopters for routine check-ins.
 * 2. Receive call statuses and summaries via Webhook.
 */

// 🔧 CONFIGURATION - Replace these with your actual values
const BOLNA_API_KEY = 'YOUR_API_KEY_HERE';
const AGENT_ID = 'YOUR_AGENT_ID_HERE';

// Column mappings (don't change these)
const COL_NAME = 0, COL_PHONE = 1, COL_PET_NAME = 2;
const COL_STATUS = 3, COL_DATE = 4, COL_NOTES = 5;

/**
 * triggers calls for rows where the 'Status' is empty.
 * Run this manually or set up a Time-driven trigger.
 */
function triggerCalls() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const dataRange = sheet.getDataRange();
  const data = dataRange.getValues();
  
  console.log(`Starting execution. Found ${data.length} rows.`);
  
  // Start from row 1 (skipping header at row 0)
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = row[COL_STATUS];
    const phone = row[COL_PHONE];
    const name = row[COL_NAME];
    const petName = row[COL_PET_NAME];
    
    // Only trigger if status is empty OR if it contains a previous Error
    // This allows you to retry failed rows without manually clearing them
    const shouldProcess = (status === "" || String(status).startsWith("Error:"));

    if (shouldProcess && phone) {
      console.log(`Processing row ${i + 1}: ${name} (${phone})`);
      try {
        const response = callBolnaAgent(phone, name, petName);
        console.log(`API Response for ${name}:`, JSON.stringify(response));
        
        // Update status to "Initiated" so we don't call again
        sheet.getRange(i + 1, COL_STATUS + 1).setValue("Initiated");
        console.log(`Successfully initiated call for ${name}`);
      } catch (e) {
        console.error(`Failed to trigger call for ${name}: ${e.message}`);
        sheet.getRange(i + 1, COL_STATUS + 1).setValue("Error: " + e.message);
      }
    } else {
       if (!shouldProcess) {
         console.log(`Skipping row ${i + 1} (${name}): Status is '${status}' (Not empty or error)`);
       } else {
         console.log(`Skipping row ${i + 1} (${name}): Missing phone number`);
       }
    }
  }
}

/**
 * Helper function to make the API request to Bolna.
 */
function callBolnaAgent(phoneNumber, customerName, petName) {
  const url = 'https://api.bolna.ai/call'; 
  
  console.log(`Preparing to call ${url} for agent ${AGENT_ID}`);

  // Ensure phone number has '+' prefix
  let formattedPhone = String(phoneNumber).trim();
  if (!formattedPhone.startsWith('+')) {
    formattedPhone = '+' + formattedPhone;
  }
  
  const payload = {
    agent_id: AGENT_ID,
    recipient_phone_number: formattedPhone,
    user_data: {
      name: customerName,       // MATCHES AGENT PROMPT {name}
      pet_name: petName,        // MATCHES AGENT PROMPT {pet_name}
      check_in_date: new Date().toISOString().split('T')[0]
    }
  };
  
  console.log("Payload:", JSON.stringify(payload));

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': `Bearer ${BOLNA_API_KEY}`
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true // This allows us to see the 404/500 body instead of just crashing
  };

  // Make the request
  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode();
  const responseBody = response.getContentText();
  
  console.log(`Response Code: ${responseCode}`);
  
  if (responseCode !== 200 && responseCode !== 201) {
    throw new Error(`API Error (${responseCode}): ${responseBody}`);
  }
  
  return JSON.parse(responseBody);
}

/**
 * Webhook receiver.
 * Bolna will call this URL when the call is finished (if configured in Bolna).
 * 
 * DEPLOYMENT INSTRUCTIONS:
 * 1. Click "Deploy" > "New deployment"
 * 2. Select type "Web app"
 * 3. Execute as: "Me"
 * 4. Who has access: "Anyone" (required for Bolna to reach it)
 */
function doPost(e) {
  try {
    // Parse the incoming JSON from Bolna
    const postData = JSON.parse(e.postData.contents);
    
    // Log the entire payload for debugging (viewable in Apps Script Executions)
    console.log("Webhook Payload:", JSON.stringify(postData));
    
    // Extract relevant info based on actual Bolna Payload structure
    let status = postData.status; // "completed"
    
    // PHONE NUMBER EXTRACTION (Robust)
    // Check multiple places where Bolna might put the phone number
    let phone = postData.recipient_phone_number || postData.phone_number;
    
    if (!phone && postData.extracted_data && postData.extracted_data.user_number) {
      phone = postData.extracted_data.user_number;
    }
    if (!phone && postData.telephony_data && postData.telephony_data.to_number) {
      phone = postData.telephony_data.to_number;
    }

    // SUMMARY / NOTES EXTRACTION
    // Prioritize Agent Extraction -> then Summary -> then Transcript
    let summary = "No summary provided";
    
    if (postData.agent_extraction && postData.agent_extraction.check_in_notes) {
      summary = postData.agent_extraction.check_in_notes;
    } else if (postData.summary) {
      summary = postData.summary;
    } else if (postData.transcript) {
      summary = postData.transcript; // Last resort
    }
    
    // STATUS OVERRIDE
    // If agent extracted a specific status (e.g., "needs follow-up"), use it
    if (postData.agent_extraction && postData.agent_extraction.check_in_status) {
      status = postData.agent_extraction.check_in_status;
    }
    
    if (!phone) {
      console.error("No phone number found in payload!");
      return ContentService.createTextOutput("No phone number found in payload");
    }

    // Update the sheet
    console.log(`Updating sheet for phone ${phone} with status: ${status}`);
    updateSheetWithStatus(phone, status, summary);
    
    return ContentService.createTextOutput("Success");
    
  } catch (error) {
    console.error("Webhook Error: " + error.toString());
    return ContentService.createTextOutput("Error processing webhook");
  }
}

/**
 * Finds the row with the matching phone number and updates Status/Notes.
 */
function updateSheetWithStatus(phoneNumber, status, notes) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const data = sheet.getDataRange().getValues();
  
  // Normalize phone numbers for comparison (remove spaces, +, etc if needed)
  // We grab the last 10 digits to be safe against +91 vs 91
  const targetPhone = String(phoneNumber).replace(/\D/g, '');
  const targetLast10 = targetPhone.slice(-10);
  
  console.log(`Searching for phone match (last 10): ${targetLast10} (full: ${phoneNumber})`);

  for (let i = 1; i < data.length; i++) {
    const rowPhone = String(data[i][COL_PHONE]).replace(/\D/g, '');
    
    // Robust Match: If exact match OR ends with the same 10 digits
    if (rowPhone === targetPhone || rowPhone.endsWith(targetLast10)) {
      console.log(`Match found at row ${i + 1}`);
      
      // Update Status (Column D -> index 3 -> column 4)
      sheet.getRange(i + 1, COL_STATUS + 1).setValue(status);
      
      // Update Check-in Date (Column E -> index 4 -> column 5) to today
      sheet.getRange(i + 1, COL_DATE + 1).setValue(new Date());
      
      // Update Notes (Column F -> index 5 -> column 6)
      if (notes) {
        sheet.getRange(i + 1, COL_NOTES + 1).setValue(notes);
      }
      break; // Stop after finding the match
    }
  }
}
