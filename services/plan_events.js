'use strict';

const HOURS = 60 * 60 * 1000;

function buildTreatmentEvents({
  userId,
  stage,
  dueAt,
  slotEnd = null,
  source = null,
  reason = null,
  stageOptionId = null,
  autoplanRunId = null,
}) {
  if (!userId || !stage || !dueAt) return [];
  const events = [
    {
      user_id: userId,
      plan_id: stage.plan_id,
      stage_id: stage.id,
      stage_option_id: stageOptionId || null,
      type: 'treatment',
      due_at: dueAt,
      slot_end: slotEnd,
      status: 'scheduled',
      reason: reason || null,
      source: source || null,
      autoplan_run_id: autoplanRunId || null,
    },
  ];

  const phiDays = Number(stage.phi_days || 0);
  if (phiDays > 0) {
    const phiAt = new Date(dueAt.getTime() + phiDays * 24 * HOURS);
    events.push({
      user_id: userId,
      plan_id: stage.plan_id,
      stage_id: stage.id,
      stage_option_id: stageOptionId || null,
      type: 'phi',
      due_at: phiAt,
      slot_end: null,
      status: 'scheduled',
      reason: null,
      source: source || null,
      autoplan_run_id: autoplanRunId || null,
    });
  }

  return events;
}

function buildReminderPayloads(events) {
  return (events || [])
    .filter((event) => event.due_at)
    .map((event) => ({
      user_id: event.user_id,
      event_id: event.id,
      fire_at: event.due_at,
      payload: {
        type: event.type,
        stage_id: event.stage_id,
        plan_id: event.plan_id,
      },
    }));
}

module.exports = {
  HOURS,
  buildTreatmentEvents,
  buildReminderPayloads,
};
