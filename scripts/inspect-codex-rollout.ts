import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: tsx scripts/inspect-codex-rollout.ts <rollout.jsonl>');
  process.exitCode = 2;
} else {
  const topLevelTypes = new Set<string>();
  const payloadTypes = new Set<string>();
  const eventTypes = new Set<string>();
  const topLevelFields = new Set<string>();
  const payloadFields = new Set<string>();
  let hasErrorMetadata = false;
  let inspected = 0;

  const lines = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (inspected >= 10_000) {
      break;
    }
    inspected += 1;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      for (const field of Object.keys(record)) {
        topLevelFields.add(field);
      }
      if (typeof record.type === 'string') {
        topLevelTypes.add(record.type);
      }
      const payload =
        record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
          ? (record.payload as Record<string, unknown>)
          : null;
      if (payload) {
        for (const field of Object.keys(payload)) {
          payloadFields.add(field);
        }
        if (typeof payload.type === 'string') {
          payloadTypes.add(payload.type);
        }
        if (typeof payload.event_type === 'string') {
          eventTypes.add(payload.event_type);
        }
        hasErrorMetadata ||= 'codex_error_info' in payload || 'codexErrorInfo' in payload;
      }
    } catch {
      // Invalid lines are counted but never printed.
    }
  }

  console.log(
    JSON.stringify(
      {
        inspectedRecords: inspected,
        topLevelRecordTypes: [...topLevelTypes].sort(),
        payloadTypes: [...payloadTypes].sort(),
        eventTypes: [...eventTypes].sort(),
        topLevelFields: [...topLevelFields].sort(),
        payloadFields: [...payloadFields].sort(),
        hasErrorMetadata,
      },
      null,
      2,
    ),
  );
}
