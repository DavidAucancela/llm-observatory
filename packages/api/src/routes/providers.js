const express = require('express');
const { PROVIDERS, PROVIDER_CAPS, PROVIDER_LABELS, ADMIN_KEY_HELP } = require('../constants/providers');

const router = express.Router();

// GET /api/providers — the capability matrix the web app builds its provider
// pickers from. Exists so the frontend stops carrying its own copies of "which
// providers support sync" / "which ones have admin keys": those copies had
// already drifted out of sync with the API (the alert-rule dropdown offered
// providers the API rejected with a 400).
//
// Static data, identical for every org, so no org scoping and no DB hit.
router.get('/', (req, res) => {
  res.json({
    providers: PROVIDERS.map(id => ({
      id,
      label: PROVIDER_LABELS[id],
      ...PROVIDER_CAPS[id],
      adminKeyHelp: ADMIN_KEY_HELP[id] || null,
    })),
  });
});

module.exports = router;
