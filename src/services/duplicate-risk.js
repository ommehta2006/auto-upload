const SAFE_STAGES = new Set(['BEFORE_STUDIO_OPEN', 'BEFORE_FILE_SELECTION']);
const POSSIBLE_STAGES = new Set(['FILE_SELECTED', 'METADATA_ENTERED', 'PROCESSING_STARTED', 'VISIBILITY_SELECTED']);
const HIGH_RISK_STAGES = new Set(['SAVE_OR_PUBLISH_CLICKED', 'COMPLETION_CONFIRMED']);

export function assessDuplicateRisk(upload) {
  const stage = String(upload?.workflow_stage || 'BEFORE_STUDIO_OPEN');
  if (upload?.youtube_url || upload?.youtube_video_id) return { risk:'HIGH', reviewRequired:true, reason:'A YouTube result already exists.' };
  if (SAFE_STAGES.has(stage)) return { risk:'NONE', reviewRequired:false, reason:'Upload stopped before file selection.' };
  if (HIGH_RISK_STAGES.has(stage)) return { risk:'HIGH', reviewRequired:true, reason:'Upload stopped after save or publish was clicked.' };
  if (POSSIBLE_STAGES.has(stage)) return { risk:'POSSIBLE', reviewRequired:false, reason:'Upload stopped after the file was selected; confirm before retrying.' };
  return { risk:'UNKNOWN', reviewRequired:true, reason:'Upload stopped at an unknown workflow stage.' };
}
