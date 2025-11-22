'use strict';

const { resolveObjectLocation } = require('./location_utils');

function pickLocationLabel(context) {
  if (context?.object?.meta?.geo_label) return context.object.meta.geo_label;
  if (context?.object?.location_tag) return context.object.location_tag;
  return null;
}

function formatCoords(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`;
}

function buildLocationDetails(location, fallbackLabel = null) {
  const parts = [];
  const label = location?.label || fallbackLabel;
  if (label) parts.push(`возле ${label}`);
  const coords = formatCoords(location?.lat, location?.lon);
  if (coords) parts.push(coords);
  if (!parts.length) return '';
  return `: ${parts.join(' • ')}`;
}

function resolveLocation(context, fallbackLat = null, fallbackLon = null) {
  const meta = (context?.object && context.object.meta) || {};
  const label = pickLocationLabel(context);
  return resolveObjectLocation(meta, fallbackLat, fallbackLon, label);
}

async function processAutoplanContext(context, deps = {}) {
  if (!context) throw new Error('processAutoplanContext requires context');
  const {
    planner,
    db,
    strings = {},
    fallbackLat = null,
    fallbackLon = null,
    trackLocation = null,
    maybeNotifyDefaultLocation = null,
    sendSlotCard = null,
    notifyNoWindow = null,
    notifyFailure = null,
    updateTimeSession = null,
    logger = console,
  } = deps;
  if (!planner || typeof planner.findWindow !== 'function') {
    throw new Error('processAutoplanContext requires planner.findWindow');
  }
  if (!db || typeof db.updateAutoplanRun !== 'function' || typeof db.upsertTreatmentSlot !== 'function') {
    throw new Error('processAutoplanContext requires db methods');
  }

  const runId = context.run?.id;
  if (!runId) throw new Error('processAutoplanContext requires run id');

  const location = resolveLocation(context, fallbackLat, fallbackLon);
  const label = pickLocationLabel(context);
  const locationDetails = {
    runId,
    planId: context.plan?.id || null,
    objectId: context.plan?.object_id || context.object?.id || null,
    source: location.source || 'unknown',
    lat: location.lat,
    lon: location.lon,
    label: location.label || label || null,
    warned: Boolean(location.warned),
  };

  if (trackLocation) {
    await trackLocation(context, locationDetails);
  }
  if (logger?.info) {
    logger.info('autoplan_core.location', locationDetails);
  }

  const stageRules = (context.stage?.meta && context.stage.meta.weather) || {};
  try {
    await db.updateAutoplanRun(runId, {
      status: 'in_progress',
      started_at: new Date(),
    });
    if (locationDetails.source === 'default' && maybeNotifyDefaultLocation) {
      await maybeNotifyDefaultLocation(context, locationDetails, strings);
    }
    const slot = await planner.findWindow({
      latitude: locationDetails.lat,
      longitude: locationDetails.lon,
      minHoursAhead: context.run?.min_hours_ahead,
      horizonHours: context.run?.horizon_hours,
      rules: stageRules,
    });
    if (!slot) {
      await db.updateAutoplanRun(runId, {
        status: 'awaiting_window',
        reason: 'no_window',
        finished_at: new Date(),
      });
      if (notifyNoWindow) await notifyNoWindow(context, strings);
      return { status: 'awaiting_window', location: locationDetails };
    }
    const savedSlot = await db.upsertTreatmentSlot({
      autoplan_run_id: runId,
      plan_id: context.plan?.id,
      stage_id: context.stage?.id,
      stage_option_id: context.run?.stage_option_id || null,
      slot_start: slot.start,
      slot_end: slot.end,
      score: slot.score ?? null,
      reason: Array.isArray(slot.reason) ? slot.reason : slot.reason ? [slot.reason] : [],
      status: 'proposed',
    });
    await db.updateAutoplanRun(runId, {
      status: 'awaiting_confirmation',
      reason: (Array.isArray(slot.reason) ? slot.reason : slot.reason ? [slot.reason] : []).join('; '),
      finished_at: new Date(),
    });
    if (updateTimeSession && context.plan?.id) {
      await updateTimeSession(context.plan.id, {
        step: 'time_autoplan_slot',
        state: {
          planId: context.plan.id,
          stageId: context.stage?.id,
          stageOptionId: context.run?.stage_option_id || null,
          slotId: savedSlot.id,
        },
      });
    }
    if (sendSlotCard) {
      await sendSlotCard(context, savedSlot, strings);
    }
    return { status: 'slot_proposed', slot: savedSlot, location: locationDetails };
  } catch (err) {
    if (logger?.error) {
      logger.error('autoplan_core.failed', { runId, error: err?.message });
    }
    await db.updateAutoplanRun(runId, {
      status: 'failed',
      error: err?.message,
      finished_at: new Date(),
    });
    if (notifyFailure) await notifyFailure(context, strings);
    throw err;
  }
}

module.exports = {
  processAutoplanContext,
  resolveLocation,
  pickLocationLabel,
  buildLocationDetails,
  formatCoords,
};
