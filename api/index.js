'use strict';
// Vercel Function: every /api/* request is routed here (see vercel.json).
const { handle } = require('../server/app');

module.exports = (req, res) => handle(req, res);
