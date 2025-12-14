const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { dbHelpers } = require('../utils/database');
const {
  getUISPClient,
  getUISPClientPayments,
  syncAllClients,
  syncSingleClient
} = require('../services/uispService');

/**
 * GET /api/payments
 * Get all payments with pagination
 */
router.get('/payments', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const payments = await dbHelpers.getAllPayments(limit, offset);

    res.json({
      success: true,
      data: payments,
      pagination: {
        limit,
        offset,
        count: payments.length
      }
    });

  } catch (error) {
    logger.error('Error fetching payments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payments',
      message: error.message
    });
  }
});

/**
 * GET /api/payments/:transactionId
 * Get specific payment by transaction ID
 */
router.get('/payments/:transactionId', async (req, res) => {
  try {
    const payment = await dbHelpers.getPaymentByTransactionId(req.params.transactionId);

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Payment not found'
      });
    }

    res.json({
      success: true,
      data: payment
    });

  } catch (error) {
    logger.error('Error fetching payment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payment',
      message: error.message
    });
  }
});

/**
 * GET /api/clients/:clientId/payments
 * Get all payments for a specific client
 */
router.get('/clients/:clientId/payments', async (req, res) => {
  try {
    const payments = await dbHelpers.getPaymentsByClientId(req.params.clientId);

    res.json({
      success: true,
      data: payments,
      count: payments.length
    });

  } catch (error) {
    logger.error('Error fetching client payments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch client payments',
      message: error.message
    });
  }
});

/**
 * GET /api/stats
 * Get payment statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await dbHelpers.getPaymentStats();

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    logger.error('Error fetching stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics',
      message: error.message
    });
  }
});

/**
 * GET /api/health
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ========== CLIENT ENDPOINTS ==========
// IMPORTANT: Specific routes must come BEFORE parameterized routes

/**
 * GET /api/clients/stats
 * Get client statistics from local database
 */
router.get('/clients/stats', async (req, res) => {
  try {
    const stats = await dbHelpers.getClientStats();

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    logger.error('Error fetching client stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch client statistics',
      message: error.message
    });
  }
});

/**
 * GET /api/clients
 * Get all clients from local database
 * Query params: limit, offset, search, is_active, is_suspended
 */
router.get('/clients', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.search;

    let clients;

    if (search) {
      clients = await dbHelpers.searchClients(search);
    } else {
      // Build filters object
      const filters = {};

      if (req.query.is_active !== undefined) {
        filters.is_active = req.query.is_active === 'true' || req.query.is_active === '1';
      }

      if (req.query.is_suspended !== undefined) {
        filters.is_suspended = req.query.is_suspended === 'true' || req.query.is_suspended === '1';
      }

      clients = await dbHelpers.getAllClients(limit, offset, filters);
    }

    res.json({
      success: true,
      data: clients,
      pagination: {
        limit,
        offset,
        count: clients.length
      }
    });

  } catch (error) {
    logger.error('Error fetching clients:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch clients',
      message: error.message
    });
  }
});

/**
 * GET /api/clients/:clientId
 * Get client information from UISP
 */
router.get('/clients/:clientId', async (req, res) => {
  try {
    const clientData = await getUISPClient(req.params.clientId);

    res.json({
      success: true,
      data: clientData
    });

  } catch (error) {
    logger.error('Error fetching client from UISP:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch client data',
      message: error.message
    });
  }
});

/**
 * GET /api/clients/:clientId/uisp-payments
 * Get payment history from UISP for a client
 */
router.get('/clients/:clientId/uisp-payments', async (req, res) => {
  try {
    const payments = await getUISPClientPayments(req.params.clientId);

    res.json({
      success: true,
      data: payments
    });

  } catch (error) {
    logger.error('Error fetching UISP payments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch UISP payment data',
      message: error.message
    });
  }
});

/**
 * POST /api/clients/sync
 * Trigger full client sync from UISP
 */
router.post('/clients/sync', async (req, res) => {
  try {
    logger.info('Client sync requested');

    // Start sync in background (don't wait for completion)
    syncAllClients()
      .then(result => {
        logger.info('Background sync completed:', result);
      })
      .catch(error => {
        logger.error('Background sync failed:', error);
      });

    res.json({
      success: true,
      message: 'Client sync started in background',
      status: 'in_progress'
    });

  } catch (error) {
    logger.error('Error starting client sync:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start client sync',
      message: error.message
    });
  }
});

/**
 * POST /api/clients/sync/wait
 * Trigger full client sync and wait for completion
 */
router.post('/clients/sync/wait', async (req, res) => {
  try {
    logger.info('Synchronous client sync requested');

    const result = await syncAllClients();

    res.json({
      success: true,
      message: 'Client sync completed',
      data: result
    });

  } catch (error) {
    logger.error('Error during client sync:', error);
    res.status(500).json({
      success: false,
      error: 'Client sync failed',
      message: error.message
    });
  }
});

/**
 * POST /api/clients/:clientId/sync
 * Sync a single client from UISP
 */
router.post('/clients/:clientId/sync', async (req, res) => {
  try {
    const clientId = req.params.clientId;
    const clientData = await syncSingleClient(parseInt(clientId));

    res.json({
      success: true,
      message: 'Client synced successfully',
      data: clientData
    });

  } catch (error) {
    logger.error(`Error syncing client ${req.params.clientId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to sync client',
      message: error.message
    });
  }
});

/**
 * GET /api/sync/logs
 * Get recent sync logs
 */
router.get('/sync/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const logs = await dbHelpers.getRecentSyncLogs(limit);

    res.json({
      success: true,
      data: logs
    });

  } catch (error) {
    logger.error('Error fetching sync logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch sync logs',
      message: error.message
    });
  }
});

module.exports = router;
