// Every size and count bound Glue enforces. Error messages and tool descriptions state some of
// these values in words; change them together.

const KiB = 1024;
const MiB = 1024 * KiB;

// Saved records.
/** Handoff Markdown, in UTF-8 bytes. Also the string-length bound of the schema. */
export const MAX_MARKDOWN_BYTES = 32768;
export const MAX_CONTEXT_PATH_LENGTH = 500;
export const MAX_SOURCE_PATH_LENGTH = 1000;
export const MAX_TITLE_LENGTH = 200;
export const MAX_SCOPE_LENGTH = 2000;
export const MAX_LABEL_LENGTH = 200;
export const MAX_BASIS_LENGTH = 500;
/** Selected evidence files per revision. */
export const MAX_EVIDENCE_FILES = 64;
/** Declared dependency pins per revision. */
export const MAX_DEPENDENCIES = 32;
/** Captures per revision, and per transfer bundle. */
export const MAX_CAPTURES = 16;
/** Decoded bytes of one capture. */
export const MAX_CAPTURE_BYTES = 1 * MiB;
/** Base64 characters of one submitted capture. */
export const MAX_CAPTURE_BASE64_LENGTH = 1400000;
/** Selected evidence plus captures read by one save. */
export const MAX_SELECTED_BYTES = 64 * MiB;

// Stored files.
/** One evidence snapshot, capture snapshot, or live source file read. */
export const MAX_FILE_BYTES = 16 * MiB;
export const MAX_REVISION_BYTES = 2 * MAX_FILE_BYTES;
/** HEAD.json and PROJECT.json. */
export const MAX_POINTER_BYTES = 4096;
/** The context Markdown working copy. */
export const MAX_WORKING_COPY_BYTES = 131072;
/** Revisions walked when looking up committed history or a retried request. */
export const MAX_HISTORY_REVISIONS = 10000;
/** Context directories enumerated during identity lookup. */
export const MAX_CONTEXT_IDENTITIES = 10000;

// Resume basis checks.
/** Records visited, and issues reported, by one basis check. */
export const MAX_BASIS_RECORDS = 64;
/** Snapshot and live-source bytes read by one basis check. */
export const MAX_BASIS_CHECK_BYTES = 64 * MiB;

// Exact reads.
export const DEFAULT_READ_BYTES = 4096;
export const MAX_READ_BYTES = 8192;

// Search.
export const MAX_QUERY_LENGTH = 500;
export const DEFAULT_FIND_RESULTS = 10;
export const MAX_FIND_RESULTS = 20;
/** Revisions scanned per page. */
export const MAX_SCANNED_REVISIONS = 64;
/** Gaps reported per page. */
export const MAX_SEARCH_GAPS = 64;
/** Evidence and capture bytes searched per page. */
export const MAX_SEARCHED_EVIDENCE_BYTES = 1 * MiB;
/** Larger evidence or captures match by name only. */
export const MAX_SEARCHED_BODY_BYTES = 256 * KiB;
export const LONG_EXCERPT_LENGTH = 480;
export const SHORT_EXCERPT_LENGTH = 160;

// Transfer.
/** A serialized transfer bundle, and the selected bytes that go into it. */
export const MAX_BUNDLE_BYTES = 1 * MiB;

// MCP transport.
/** One JSON-RPC line. Longer lines are discarded up to their newline. */
export const MAX_LINE_BYTES = 2 * MiB;
/** Input queued from hosts whose stdin only emits data events. */
export const MAX_QUEUED_INPUT_BYTES = 4 * MiB;
export const MAX_QUEUED_INPUT_CHUNKS = 1024;

// Recovery CLI.
export const MAX_RECOVERY_REQUEST_BYTES = 100000;
