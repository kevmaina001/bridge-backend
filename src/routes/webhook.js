const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { dbHelpers } = require('../utils/database');
const { postPaymentToUISP, syncSingleClient } = require('../services/uispService');
const { validateWebhookSignature } = require('../middleware/webhookValidator');

/**
 * POST /webhook/payment
 * Receive payment webhook from Splynx
 */
router.post('/payment', validateWebhookSignature, async (req, res) => {
  const startTime = Date.now();

  try {
    // Log webhook received
    const clientIp = req.ip || req.connection.remoteAddress;
    await dbHelpers.logWebhook(req.body, req.headers, clientIp, req.webhookValidated);

    logger.info('Payment webhook received', {
      validated: req.webhookValidated,
      ip: clientIp
    });

    // Extract payment data from Splynx webhook
    // Adjust this based on actual Splynx webhook payload structure
    let paymentData;

    if (req.body.data && req.body.data.attributes) {
      // JSON API format
      paymentData = req.body.data.attributes;
    } else if (req.body.payment) {
      // Direct payment object
      paymentData = req.body.payment;
    } else {
      // Assume body is the payment data
      paymentData = req.body;
    }

    // Check if this is a test/ping request (empty payload or no data)
    if (!paymentData || Object.keys(paymentData).length === 0) {
      logger.info('Webhook test/ping request received');
      return res.status(200).json({
        success: true,
        message: 'Webhook endpoint is active and ready to receive payments'
      });
    }

    // Map Splynx field names to our expected field names
    if (paymentData.customer_id && !paymentData.client_id) {
      paymentData.client_id = paymentData.customer_id;
    }

    // Validate required fields
    const requiredFields = ['client_id', 'amount'];
    const missingFields = requiredFields.filter(field => !paymentData[field]);

    if (missingFields.length > 0) {
      logger.warn('Webhook test request with incomplete data', {
        missingFields,
        receivedFields: Object.keys(paymentData)
      });

      // Return success for test requests, error for actual malformed payments
      if (Object.keys(paymentData).length < 3) {
        // Likely a test request with minimal data
        return res.status(200).json({
          success: true,
          message: 'Webhook endpoint is active. Required fields for actual payments: client_id, amount'
        });
      }

      return res.status(400).json({
        error: 'Missing required fields',
        missingFields
      });
    }

    // Generate transaction ID if not provided
    if (!paymentData.transaction_id) {
      paymentData.transaction_id = `SPLYNX-${Date.now()}-${paymentData.client_id}`;
    }

    // Check if payment already exists (idempotency)
    const existingPayment = await dbHelpers.getPaymentByTransactionId(paymentData.transaction_id);

    if (existingPayment) {
      logger.warn('Payment already processed', {
        transactionId: paymentData.transaction_id,
        status: existingPayment.status
      });

      return res.status(200).json({
        message: 'Payment already processed',
        transactionId: paymentData.transaction_id,
        status: existingPayment.status
      });
    }

    // Store payment in database with pending status
    const paymentRecord = {
      transaction_id: paymentData.transaction_id,
      client_id: paymentData.client_id,
      amount: paymentData.amount,
      currency_code: paymentData.currency_code || 'KES',
      payment_type: paymentData.payment_type,
      payment_method: paymentData.payment_method || paymentData.payment_type,
      created_at: paymentData.created_at || new Date().toISOString()
    };

    await dbHelpers.insertPayment(paymentRecord);

    logger.info('Payment stored in database', {
      transactionId: paymentData.transaction_id
    });

    // Post payment to UISP
    try {
      const uispResponse = await postPaymentToUISP(paymentData);

      // Update payment status to success
      await dbHelpers.updatePaymentStatus(
        paymentData.transaction_id,
        'success',
        JSON.stringify(uispResponse),
        null
      );

      // Sync client data from UISP (in background, don't wait)
      syncSingleClient(parseInt(paymentData.client_id))
        .then(() => {
          logger.info(`Client ${paymentData.client_id} synced successfully`);
          // Update last payment timestamp
          return dbHelpers.updateClientLastPayment(parseInt(paymentData.client_id));
        })
        .catch(error => {
          logger.warn(`Failed to sync client ${paymentData.client_id}:`, error.message);
        });

      const duration = Date.now() - startTime;

      logger.info('Payment successfully processed', {
        transactionId: paymentData.transaction_id,
        duration: `${duration}ms`
      });

      res.status(200).json({
        message: 'Payment successfully posted to UISP',
        transactionId: paymentData.transaction_id,
        uispPaymentId: uispResponse?.id,
        duration: `${duration}ms`
      });

    } catch (uispError) {
      // Update payment status to failed
      await dbHelpers.updatePaymentStatus(
        paymentData.transaction_id,
        'failed',
        null,
        uispError.message
      );

      logger.error('Failed to post payment to UISP', {
        transactionId: paymentData.transaction_id,
        error: uispError.message,
        stack: uispError.stack
      });

      res.status(500).json({
        error: 'Failed to post payment to UISP',
        transactionId: paymentData.transaction_id,
        message: uispError.message
      });
    }

  } catch (error) {
    logger.error('Error processing webhook', {
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * GET /webhook/test
 * Test endpoint to verify webhook is working
 */
router.get('/test', (req, res) => {
  res.json({
    message: 'Webhook endpoint is active',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
