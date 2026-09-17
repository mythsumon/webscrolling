/** JSON and CSV serialisation of a scrape result. */

/** @param {object} result */
export function toJson(result, { pretty = true, includeProvenance = true } = {}) {
  let payload = result;
  if (!includeProvenance) {
    payload =
      result.mode === 'list'
        // The records *are* the data in list mode; dropping them would leave
        // `--data-only` printing nothing but a status.
        ? {
          url: result.url,
          status: result.status,
          record_count: result.record_count,
          records: result.records,
          missing_fields: result.missing_fields,
        }
        : {
          url: result.url,
          status: result.status,
          data: result.data,
          missing_fields: result.missing_fields,
        };
  }
  return JSON.stringify(payload, null, pretty ? 2 : 0);
}

/**
 * CSV for a scrape result.
 *
 * Two shapes, because the two modes are genuinely different tables: a
 * single-record result is one row per label (a vertical fact sheet), while a
 * list result is one row per record with a column per label — which is the
 * spreadsheet people actually want out of a directory page.
 */
export function toCsv(result) {
  if (result.mode === 'list') return listToCsv(result);
  return singleToCsv(result);
}

function listToCsv(result) {
  const fields = result.record_fields?.[0]
    ? Object.keys(result.record_fields[0])
    : [...new Set(result.records.flatMap((r) => Object.keys(r)))].filter((k) => !k.startsWith('_'));

  const header = [...fields, 'source_url'];
  const rows = [header];

  for (const record of result.records ?? []) {
    rows.push([
      ...fields.map((key) => {
        const value = record[key];
        return Array.isArray(value) ? value.join(' | ') : value ?? '';
      }),
      record._source_url ?? result.url ?? '',
    ]);
  }

  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** One row per label. */
function singleToCsv(result) {
  const header = ['label', 'field_key', 'value', 'value_type', 'source_url', 'method', 'confidence', 'found'];
  const rows = [header];

  for (const [key, field] of Object.entries(result.fields ?? {})) {
    const value = Array.isArray(field.value) ? field.value.join(' | ') : field.value ?? '';
    rows.push([
      field.label,
      key,
      value,
      field.value_type ?? '',
      field.source_url ?? '',
      field.method ?? '',
      field.confidence ?? '',
      field.found ? 'yes' : 'no',
    ]);
  }

  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  // Guard against CSV formula injection when the file is opened in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
