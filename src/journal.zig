const std = @import("std");
const agent_instructions = @import("agent_instructions");
const native_sdk = @import("native_sdk");
const ollama = @import("ollama.zig");
const vault_mod = @import("vault.zig");

pub const chunk_bytes: usize = 8 * 1024;
/// Bridge responses cap at 1 MiB. Read pages stay well under that even after
/// JSON escaping, so one page carries far more than the 8 KiB save chunks.
pub const read_chunk_bytes: usize = 128 * 1024;
/// `journal.save` accepts at most 1 MiB across all chunks.
pub const max_save_body_bytes: usize = 1024 * 1024;
/// Native query pages cap one encoded row at 256 KiB. Journal bodies can
/// exceed that once they are stored, so we never SELECT that column whole.
/// Chat events are one row each; a single event still has to fit a page,
/// so saves reject an event larger than chat_event_max_plaintext_bytes.
const stored_column_read_bytes: usize = 64 * 1024;
/// Base64 ciphertext grows a plaintext event by about a third. Capping the
/// plaintext at 128 KiB keeps the stored row well under the 256 KiB page
/// row cap whether or not encryption is on.
const chat_event_max_plaintext_bytes: usize = 128 * 1024;
/// `chat.get` splices raw event JSON, so a page can grow toward the 1 MiB
/// bridge cap. Stop well under that and keep paging by `seq`.
const chat_read_events_budget: usize = 512 * 1024;
const chat_search_hits_per_conversation: usize = 3;
const chat_title_recent_messages: usize = 4;
const chat_search_max_hits: usize = 25;
const memory_search_max_hits: usize = 25;
const chat_event_insert_sql = "INSERT INTO chat_event (conversation_id, seq, event) VALUES (?1, ?2, ?3);";
const chat_event_insert_bytes: usize = 4 * 1024 * 1024;

pub const migrations = [_]native_sdk.relational_store.Migration{
    .{ .version = 1, .name = "journal", .sql = @embedFile("schema/0001_journal.sql") },
    .{ .version = 2, .name = "body_format", .sql = @embedFile("schema/0002_body_format.sql") },
    .{ .version = 3, .name = "embeddings", .sql = @embedFile("schema/0003_embeddings.sql") },
    .{ .version = 4, .name = "updated_at", .sql = @embedFile("schema/0004_updated_at.sql") },
    .{ .version = 5, .name = "lock", .sql = @embedFile("schema/0005_lock.sql") },
    .{ .version = 6, .name = "chat", .sql = @embedFile("schema/0006_chat.sql") },
    .{ .version = 7, .name = "chat_events", .sql = @embedFile("schema/0007_chat_events.sql") },
    .{ .version = 8, .name = "summaries", .sql = @embedFile("schema/0008_summaries.sql") },
    .{ .version = 9, .name = "chat_model_prefs", .sql = @embedFile("schema/0009_chat_model_prefs.sql") },
    .{ .version = 10, .name = "chat_context_length", .sql = @embedFile("schema/0010_chat_context_length.sql") },
    .{ .version = 11, .name = "chat_context_length_default", .sql = @embedFile("schema/0011_chat_context_length_default.sql") },
    .{ .version = 12, .name = "dream", .sql = @embedFile("schema/0012_dream.sql") },
    .{ .version = 13, .name = "memory_edits", .sql = @embedFile("schema/0013_memory_edits.sql") },
    .{ .version = 14, .name = "agent_instructions", .sql = @embedFile("schema/0014_agent_instructions.sql") },
    .{ .version = 15, .name = "chat_title_locked", .sql = @embedFile("schema/0015_chat_title_locked.sql") },
    .{ .version = 16, .name = "chat_index_skip", .sql = @embedFile("schema/0016_chat_index_skip.sql") },
};

/// Shipped Chat system prompt. Settings shows this read-only. The build
/// generates this module from Eve's source so both use the same text.
pub const builtin_agent_instructions: []const u8 = agent_instructions.text;
pub const agent_user_instruction_key: []const u8 = "user";
pub const agent_user_instruction_max_bytes: usize = 8 * 1024;

pub const profile_recall_limit: i64 = 50;
pub const user_memory_source: []const u8 = "user";

pub const MemoryKind = enum {
    event,
    fact,
    profile,

    pub fn parse(name: []const u8) ?MemoryKind {
        if (std.mem.eql(u8, name, "event")) return .event;
        if (std.mem.eql(u8, name, "fact")) return .fact;
        if (std.mem.eql(u8, name, "profile")) return .profile;
        return null;
    }
};

pub const MemorySaveInput = struct {
    embedding: ?[]const f32 = null,
    event: []const u8 = "",
    fact: []const u8 = "",
    id: ?i64 = null,
    kind: MemoryKind,
    model_name: []const u8,
    occurred_at: []const u8 = "",
    subject: []const u8 = "",
};

pub const DreamSource = enum {
    entry,
    conversation,

    pub fn sqlName(self: DreamSource) []const u8 {
        return switch (self) {
            .entry => "entry",
            .conversation => "conversation",
        };
    }

    pub fn parse(name: []const u8) ?DreamSource {
        if (std.mem.eql(u8, name, "entry")) return .entry;
        if (std.mem.eql(u8, name, "conversation")) return .conversation;
        return null;
    }
};

pub const DreamItem = struct {
    source: DreamSource,
    id: i64,
    needs_memory_extraction: bool,
};

pub const ConversationText = struct {
    date: []u8,
    text: []u8,
    recent: []u8,
    title_locked: bool = false,
};

pub const MemoryFact = struct {
    fact: []const u8,
    id: i64,
    score: f32 = 0,
    subject: []const u8 = "",
};

pub const MemoryEvent = struct {
    event: []const u8,
    id: i64,
    occurred_at: []const u8,
    score: f32,
};

pub const NewFact = struct {
    embedding: ?[]const f32 = null,
    fact: []const u8,
    kind: []const u8,
    subject: []const u8,
};

pub const NewEvent = struct {
    embedding: []const f32,
    event: []const u8,
    occurred_at: []const u8,
};

pub const ChatDeleteResult = struct {
    json: []const u8,
    session_id: ?[]const u8,
};

pub const ChatExportMeta = struct {
    context_length: ?i64 = null,
    created_at: []u8 = &.{},
    eve_session_id: ?[]u8 = null,
    id: i64 = 0,
    model: []u8 = &.{},
    stream_index: i64 = 0,
    thinking: ?bool = null,
    title: []u8 = &.{},
    updated_at: []u8 = &.{},
};

pub const ChatExportEventPage = struct {
    events: [][]u8,
    next_seq: i64,
    done: bool,

    pub fn deinit(self: *ChatExportEventPage, allocator: std.mem.Allocator) void {
        for (self.events) |event| allocator.free(event);
        allocator.free(self.events);
    }
};

pub const Store = struct {
    allocator: std.mem.Allocator,
    db: native_sdk.RelationalStore,
    /// Set after init, once the vault exists (it borrows this store's
    /// database). Null means encryption is off; every read and write falls
    /// back to plaintext.
    vault: ?*vault_mod.Vault = null,
    save_active: bool = false,
    save_new: bool = false,
    save_id: i64 = 0,
    save_generation: u64 = 0,
    journal_write_generation: u64 = 0,
    save_body: std.ArrayList(u8) = .empty,
    chat_save_active: bool = false,
    chat_save_new: bool = false,
    chat_save_has_session: bool = false,
    chat_save_id: i64 = 0,
    chat_save_stream_index: i64 = 0,
    chat_save_title: std.ArrayList(u8) = .empty,
    chat_save_session: std.ArrayList(u8) = .empty,
    chat_save_model: std.ArrayList(u8) = .empty,
    chat_save_thinking: ?bool = null,
    chat_save_context_length: ?i64 = null,
    chat_save_events: std.ArrayList(u8) = .empty,
    chat_save_base_seq: i64 = 0,
    chat_save_generation: u64 = 0,
    chat_write_generation: u64 = 0,
    /// Tests set this so `scrubStorage` can return Busy after a successful
    /// rewrite, covering the enable path that leaves `enc.scrub_pending` set.
    fail_next_scrub: bool = false,
    /// Bumped before data wipes so background jobs cannot write onto rows
    /// that the wipe deletes.
    data_generation: u64 = 0,

    pub fn init(allocator: std.mem.Allocator, db: native_sdk.RelationalStore) Store {
        return .{ .allocator = allocator, .db = db };
    }

    pub fn deinit(self: *Store) void {
        self.clearSaveBody();
        self.save_body.deinit(self.allocator);
        self.chat_save_title.deinit(self.allocator);
        self.chat_save_session.deinit(self.allocator);
        self.chat_save_model.deinit(self.allocator);
        self.chat_save_events.deinit(self.allocator);
        self.db.deinit();
    }

    fn clearSaveBody(self: *Store) void {
        std.crypto.secureZero(u8, self.save_body.items);
        self.save_body.items.len = 0;
    }

    fn clearSensitiveBuffer(buffer: *std.ArrayList(u8)) void {
        std.crypto.secureZero(u8, buffer.items);
        buffer.clearRetainingCapacity();
    }

    fn resetPendingJournalSave(self: *Store) void {
        self.save_active = false;
        self.save_new = false;
        self.save_id = 0;
        self.save_generation = 0;
        self.clearSaveBody();
    }

    fn resetPendingChatSave(self: *Store) void {
        self.chat_save_active = false;
        self.chat_save_new = false;
        self.chat_save_has_session = false;
        self.chat_save_id = 0;
        self.chat_save_stream_index = 0;
        self.chat_save_base_seq = 0;
        self.chat_save_generation = 0;
        self.chat_save_thinking = null;
        self.chat_save_context_length = null;
        clearSensitiveBuffer(&self.chat_save_title);
        clearSensitiveBuffer(&self.chat_save_session);
        clearSensitiveBuffer(&self.chat_save_model);
        clearSensitiveBuffer(&self.chat_save_events);
    }

    fn beginDataWipe(self: *Store, cancel_journal_save: bool, cancel_chat_save: bool) void {
        self.data_generation += 1;
        if (cancel_journal_save) {
            self.journal_write_generation += 1;
            self.resetPendingJournalSave();
        }
        if (cancel_chat_save) {
            self.chat_write_generation += 1;
            self.resetPendingChatSave();
        }
    }

    fn encryptionOn(self: *const Store) bool {
        return if (self.vault) |v| v.enabled else false;
    }

    fn encryptForStorage(self: *Store, aad: []const u8, plaintext: []const u8) ![]u8 {
        if (self.vault) |v| return v.encryptField(self.allocator, aad, plaintext);
        return self.allocator.dupe(u8, plaintext);
    }

    fn decryptFromStorage(self: *Store, aad: []const u8, stored: []const u8) ![]u8 {
        if (self.vault) |v| return v.decryptField(self.allocator, aad, stored);
        return self.allocator.dupe(u8, stored);
    }

    fn decryptEventSourceTitle(self: *Store, source_type: []const u8, stored: []const u8) ![]u8 {
        if (stored.len == 0) return self.allocator.dupe(u8, "");
        if (std.mem.eql(u8, source_type, "entry")) {
            return self.decryptFromStorage(vault_mod.aad_entry_title, stored);
        }
        if (std.mem.eql(u8, source_type, "conversation")) {
            return self.decryptFromStorage(vault_mod.aad_chat_title, stored);
        }
        return self.allocator.dupe(u8, "");
    }

    pub fn list(self: *Store, output: []u8) ![]const u8 {
        var rows = QueryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT id, entry_date, title, word_count, body_format, updated_at FROM journal_entry ORDER BY entry_date DESC, id DESC;",
            &.{},
            &rows,
            QueryRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"entries\":[");
        for (rows.rows.items, 0..) |row, index| {
            if (index > 0) try writer.writeAll(",");
            if (self.encryptionOn()) {
                const title = try self.decryptFromStorage(vault_mod.aad_entry_title, row.title);
                defer self.allocator.free(title);
                var opened = row;
                opened.title = title;
                try writeEntryMeta(&writer, opened, null);
            } else {
                try writeEntryMeta(&writer, row, null);
            }
        }
        try writer.writeAll("]}");
        return writer.buffered();
    }

    /// Entries with no embeddings, or whose newest embedding is older than the
    /// last save.
    pub fn listPendingEmbeddings(self: *Store, output: []u8) ![]const u8 {
        var rows = QueryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            \\SELECT journal_entry.id
            \\FROM journal_entry
            \\LEFT JOIN (
            \\  SELECT entry_id, MAX(embedded_at) AS embedded_at
            \\  FROM entry_embedding
            \\  GROUP BY entry_id
            \\) emb ON emb.entry_id = journal_entry.id
            \\WHERE emb.embedded_at IS NULL
            \\   OR emb.embedded_at < journal_entry.updated_at
            \\ORDER BY journal_entry.id;
        ,
            &.{},
            &rows,
            QueryRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"ids\":[");
        for (rows.rows.items, 0..) |row, index| {
            if (index > 0) try writer.writeAll(",");
            try writer.print("{d}", .{row.id});
        }
        try writer.writeAll("]}");
        return writer.buffered();
    }

    /// Entries with no summary, or whose summary is older than the last save.
    pub fn listPendingSummaries(self: *Store, output: []u8) ![]const u8 {
        var rows = QueryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            \\SELECT journal_entry.id
            \\FROM journal_entry
            \\LEFT JOIN entry_summary ON entry_summary.entry_id = journal_entry.id
            \\WHERE entry_summary.summarized_at IS NULL
            \\   OR entry_summary.summarized_at < journal_entry.updated_at
            \\ORDER BY journal_entry.id;
        ,
            &.{},
            &rows,
            QueryRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"ids\":[");
        for (rows.rows.items, 0..) |row, index| {
            if (index > 0) try writer.writeAll(",");
            try writer.print("{d}", .{row.id});
        }
        try writer.writeAll("]}");
        return writer.buffered();
    }

    /// Conversations with no embeddings, or whose newest embedding is older
    /// than the last transcript save.
    pub fn listPendingChatEmbeddings(self: *Store, output: []u8) ![]const u8 {
        return self.listPendingIds(
            \\SELECT chat_conversation.id
            \\FROM chat_conversation
            \\LEFT JOIN (
            \\  SELECT conversation_id, MAX(embedded_at) AS embedded_at
            \\  FROM chat_embedding
            \\  GROUP BY conversation_id
            \\) emb ON emb.conversation_id = chat_conversation.id
            \\WHERE emb.embedded_at IS NULL
            \\   OR emb.embedded_at < chat_conversation.updated_at
            \\ORDER BY chat_conversation.id;
        , output);
    }

    /// Conversations with no summary, or whose summary is older than the last
    /// transcript save.
    pub fn listPendingChatSummaries(self: *Store, output: []u8) ![]const u8 {
        return self.listPendingIds(
            \\SELECT chat_conversation.id
            \\FROM chat_conversation
            \\LEFT JOIN chat_summary ON chat_summary.conversation_id = chat_conversation.id
            \\WHERE chat_summary.summarized_at IS NULL
            \\   OR chat_summary.summarized_at < chat_conversation.updated_at
            \\ORDER BY chat_conversation.id;
        , output);
    }

    /// Sources with pending Dream work or stale indexes. `needs_memory_extraction`
    /// distinguishes changed sources from index-only repairs so wiping indexes
    /// does not rerun memory extraction. Caller frees the slice via the store allocator.
    pub fn listPendingDream(self: *Store, memory_enabled: bool) ![]DreamItem {
        var rows = DreamPendingRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            \\SELECT 'entry' AS source_type, journal_entry.id AS source_id,
            \\  CASE WHEN dream_state.dreamed_at IS NULL OR dream_state.dreamed_at < journal_entry.updated_at
            \\    THEN 1 ELSE 0 END AS needs_memory_extraction
            \\FROM journal_entry
            \\LEFT JOIN dream_state
            \\  ON dream_state.source_type = 'entry'
            \\ AND dream_state.source_id = journal_entry.id
            \\LEFT JOIN entry_summary
            \\  ON entry_summary.entry_id = journal_entry.id
            \\LEFT JOIN (
            \\  SELECT entry_id, MAX(embedded_at) AS embedded_at
            \\  FROM entry_embedding
            \\  GROUP BY entry_id
            \\) emb ON emb.entry_id = journal_entry.id
            \\WHERE dream_state.dreamed_at IS NULL
            \\   OR dream_state.dreamed_at < journal_entry.updated_at
            \\   OR (journal_entry.word_count > 0 AND (
            \\     entry_summary.summarized_at IS NULL
            \\     OR entry_summary.summarized_at < journal_entry.updated_at
            \\     OR emb.embedded_at IS NULL
            \\     OR emb.embedded_at < journal_entry.updated_at
            \\   ))
            \\UNION ALL
            \\SELECT 'conversation' AS source_type, chat_conversation.id AS source_id,
            \\  CASE WHEN dream_state.dreamed_at IS NULL OR dream_state.dreamed_at < chat_conversation.updated_at
            \\    THEN 1 ELSE 0 END AS needs_memory_extraction
            \\FROM chat_conversation
            \\LEFT JOIN dream_state
            \\  ON dream_state.source_type = 'conversation'
            \\ AND dream_state.source_id = chat_conversation.id
            \\LEFT JOIN chat_summary
            \\  ON chat_summary.conversation_id = chat_conversation.id
            \\LEFT JOIN (
            \\  SELECT conversation_id, MAX(embedded_at) AS embedded_at
            \\  FROM chat_embedding
            \\  GROUP BY conversation_id
            \\) chat_emb ON chat_emb.conversation_id = chat_conversation.id
            \\WHERE dream_state.dreamed_at IS NULL
            \\   OR dream_state.dreamed_at < chat_conversation.updated_at
            \\   OR (?1 != 0 AND (
            \\     EXISTS (
            \\       SELECT 1 FROM chat_event
            \\       WHERE chat_event.conversation_id = chat_conversation.id
            \\     )
            \\   ) AND NOT EXISTS (
            \\     SELECT 1 FROM chat_index_skip
            \\     WHERE chat_index_skip.conversation_id = chat_conversation.id
            \\   ) AND (
            \\     chat_summary.summarized_at IS NULL
            \\     OR chat_summary.summarized_at < chat_conversation.updated_at
            \\     OR chat_emb.embedded_at IS NULL
            \\     OR chat_emb.embedded_at < chat_conversation.updated_at
            \\   ))
            \\ORDER BY 1, 2;
        ,
            &.{.{ .integer = if (memory_enabled) 1 else 0 }},
            &rows,
            DreamPendingRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;

        return rows.toOwnedSlice();
    }

    pub fn entryEmbeddingsStale(self: *Store, id: i64) !bool {
        return self.idMatches(
            \\SELECT journal_entry.id AS n
            \\FROM journal_entry
            \\LEFT JOIN (
            \\  SELECT entry_id, MAX(embedded_at) AS embedded_at
            \\  FROM entry_embedding
            \\  GROUP BY entry_id
            \\) emb ON emb.entry_id = journal_entry.id
            \\WHERE journal_entry.id = ?1
            \\  AND (emb.embedded_at IS NULL OR emb.embedded_at < journal_entry.updated_at);
        , id);
    }

    pub fn entrySummaryStale(self: *Store, id: i64) !bool {
        return self.idMatches(
            \\SELECT journal_entry.id AS n
            \\FROM journal_entry
            \\LEFT JOIN entry_summary ON entry_summary.entry_id = journal_entry.id
            \\WHERE journal_entry.id = ?1
            \\  AND (entry_summary.summarized_at IS NULL OR entry_summary.summarized_at < journal_entry.updated_at);
        , id);
    }

    pub fn chatEmbeddingsStale(self: *Store, id: i64) !bool {
        return self.idMatches(
            \\SELECT chat_conversation.id AS n
            \\FROM chat_conversation
            \\LEFT JOIN (
            \\  SELECT conversation_id, MAX(embedded_at) AS embedded_at
            \\  FROM chat_embedding
            \\  GROUP BY conversation_id
            \\) emb ON emb.conversation_id = chat_conversation.id
            \\WHERE chat_conversation.id = ?1
            \\  AND (emb.embedded_at IS NULL OR emb.embedded_at < chat_conversation.updated_at);
        , id);
    }

    pub fn chatSummaryStale(self: *Store, id: i64) !bool {
        return self.idMatches(
            \\SELECT chat_conversation.id AS n
            \\FROM chat_conversation
            \\LEFT JOIN chat_summary ON chat_summary.conversation_id = chat_conversation.id
            \\WHERE chat_conversation.id = ?1
            \\  AND (chat_summary.summarized_at IS NULL OR chat_summary.summarized_at < chat_conversation.updated_at);
        , id);
    }

    /// Remember that this conversation has no text to summarize or embed.
    /// A chat save that changes its events clears this marker.
    pub fn markChatIndexSkipped(self: *Store, id: i64) !void {
        const outcome = self.db.exec(&.{.{
            .sql = "INSERT INTO chat_index_skip (conversation_id) VALUES (?1) ON CONFLICT(conversation_id) DO NOTHING;",
            .params = &.{.{ .integer = id }},
        }});
        if (outcome != .ok) return error.SqliteWriteFailed;
    }

    fn listPendingIds(self: *Store, sql: []const u8, output: []u8) ![]const u8 {
        var rows = QueryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(sql, &.{}, &rows, QueryRows.collect);
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"ids\":[");
        for (rows.rows.items, 0..) |row, index| {
            if (index > 0) try writer.writeAll(",");
            try writer.print("{d}", .{row.id});
        }
        try writer.writeAll("]}");
        return writer.buffered();
    }

    fn idMatches(self: *Store, sql: []const u8, id: i64) !bool {
        var counts = CountRows{};
        const outcome = self.db.query(sql, &.{.{ .integer = id }}, &counts, CountRows.collect);
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (counts.failed) return error.SqlitePageFailed;
        return counts.found;
    }

    pub fn search(self: *Store, payload: []const u8, output: []u8) ![]const u8 {
        var string_buf: [4096]u8 = undefined;
        var used: usize = 0;
        const query = jsonString(payload, "query", &string_buf, &used) orelse return error.InvalidRequest;
        if (query.len == 0) {
            var empty = std.Io.Writer.fixed(output);
            try empty.writeAll("{\"entries\":[]}");
            return empty.buffered();
        }

        // Ciphertext cannot match a SQL LIKE pattern, so the encrypted path
        // decrypts in memory instead.
        if (self.encryptionOn()) return self.searchDecrypted(query, output);

        var pattern_buf: [8192]u8 = undefined;
        const pattern = try likeContainsPattern(query, &pattern_buf);

        var rows = QueryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT id, entry_date, title, body, word_count, body_format, updated_at FROM journal_entry WHERE title LIKE ?1 ESCAPE '\\' OR body LIKE ?1 ESCAPE '\\' ORDER BY entry_date DESC, id DESC LIMIT 25;",
            &.{.{ .text = pattern }},
            &rows,
            QueryRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"entries\":[");
        for (rows.rows.items, 0..) |row, index| {
            if (index > 0) try writer.writeAll(",");
            var excerpt_buf: [160]u8 = undefined;
            try writeEntryMeta(&writer, row, excerptFor(row.title, row.body, query, &excerpt_buf));
        }
        try writer.writeAll("]}");
        return writer.buffered();
    }

    /// Search with encryption on: page through every entry, decrypt in
    /// memory, and match there. The store's query API refuses results over
    /// 8,192 rows or 8 MB, so the scan pages by id and halves the page if a
    /// query comes back rejected. Matches are sorted by date, newest first,
    /// and capped at 25 — the same shape as the SQL LIKE path.
    fn searchDecrypted(self: *Store, query: []const u8, output: []u8) ![]const u8 {
        const v = self.vault orelse return error.VaultUnavailable;

        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();

        var matches: std.ArrayList(SearchMatch) = .empty;
        var last_id: i64 = 0;
        var page_size: i64 = 32;
        while (true) {
            var rows = QueryRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                "SELECT id, entry_date, title, body, word_count, body_format, updated_at FROM journal_entry WHERE id > ?1 ORDER BY id LIMIT ?2;",
                &.{ .{ .integer = last_id }, .{ .integer = page_size } },
                &rows,
                QueryRows.collect,
            );
            if (outcome == .rejected and page_size > 1) {
                page_size = @max(1, @divTrunc(page_size, 2));
                continue;
            }
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_id = row.id;
                const title = try v.decryptField(a, vault_mod.aad_entry_title, row.title);
                const body = try v.decryptField(a, vault_mod.aad_entry_body, row.body);
                if (std.ascii.indexOfIgnoreCase(title, query) == null and
                    std.ascii.indexOfIgnoreCase(body, query) == null) continue;
                const excerpt_buf = try a.alloc(u8, 160);
                try matches.append(a, .{
                    .row = .{
                        .id = row.id,
                        .date = try a.dupe(u8, row.date),
                        .title = title,
                        .word_count = row.word_count,
                        .format = try a.dupe(u8, row.format),
                        .updated_at = try a.dupe(u8, row.updated_at),
                    },
                    .excerpt = excerptFor(title, body, query, excerpt_buf),
                });
            }
        }

        std.mem.sort(SearchMatch, matches.items, {}, SearchMatch.newestFirst);

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"entries\":[");
        for (matches.items[0..@min(matches.items.len, 25)], 0..) |match, index| {
            if (index > 0) try writer.writeAll(",");
            try writeEntryMeta(&writer, match.row, match.excerpt);
        }
        try writer.writeAll("]}");
        return writer.buffered();
    }

    pub fn get(self: *Store, payload: []const u8, output: []u8) ![]const u8 {
        const id = jsonI64(payload, "id") orelse return error.InvalidRequest;
        const offset: usize = @intCast(jsonI64(payload, "offset") orelse 0);

        var rows = QueryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT id, entry_date, title, word_count, body_format, updated_at FROM journal_entry WHERE id = ?1;",
            &.{.{ .integer = id }},
            &rows,
            QueryRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        if (rows.rows.items.len == 0) return error.NotFound;

        const row = rows.rows.items[0];
        const title = try self.decryptFromStorage(vault_mod.aad_entry_title, row.title);
        defer self.allocator.free(title);
        const stored_body = try self.loadStoredColumn("journal_entry", "body", id);
        defer self.allocator.free(stored_body);
        const body = try self.decryptFromStorage(vault_mod.aad_entry_body, stored_body);
        defer self.allocator.free(body);
        const chunk = utf8Chunk(body, offset, read_chunk_bytes);
        const done = offset + chunk.len >= body.len;

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"id\":");
        try writer.print("{d}", .{row.id});
        try writer.writeAll(",\"title\":");
        try writeJsonString(&writer, title);
        try writer.writeAll(",\"date\":");
        try writeJsonString(&writer, row.date);
        try writer.writeAll(",\"format\":");
        try writeJsonString(&writer, row.format);
        try writer.writeAll(",\"wordCount\":");
        try writer.print("{d}", .{row.word_count});
        try writer.writeAll(",\"updatedAt\":");
        try writeJsonString(&writer, row.updated_at);
        try writer.writeAll(",\"chunk\":");
        try writeJsonStringStreaming(&writer, chunk);
        try writer.writeAll(",\"done\":");
        try writer.writeAll(if (done) "true" else "false");
        try writer.writeByte('}');
        return writer.buffered();
    }

    /// Write one decrypted journal entry as JSON. Used by the local agent
    /// HTTP server, where the body is not split across bridge chunks.
    pub fn writeEntryJson(self: *Store, id: i64, writer: *std.Io.Writer) !void {
        var rows = QueryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT id, entry_date, title, word_count, body_format FROM journal_entry WHERE id = ?1;",
            &.{.{ .integer = id }},
            &rows,
            QueryRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        if (rows.rows.items.len == 0) return error.NotFound;

        const row = rows.rows.items[0];
        const title = try self.decryptFromStorage(vault_mod.aad_entry_title, row.title);
        defer self.allocator.free(title);
        const stored_body = try self.loadStoredColumn("journal_entry", "body", id);
        defer self.allocator.free(stored_body);
        const body = try self.decryptFromStorage(vault_mod.aad_entry_body, stored_body);
        defer self.allocator.free(body);

        try writer.writeAll("{\"id\":");
        try writer.print("{d}", .{row.id});
        try writer.writeAll(",\"title\":");
        try writeJsonStringStreaming(writer, title);
        try writer.writeAll(",\"date\":");
        try writeJsonStringStreaming(writer, row.date);
        try writer.writeAll(",\"body\":");
        try writeJsonStringStreaming(writer, body);
        try writer.writeAll(",\"bodyFormat\":");
        try writeJsonStringStreaming(writer, row.format);
        try writer.writeAll(",\"wordCount\":");
        try writer.print("{d}", .{row.word_count});
        try writer.writeByte('}');
    }

    /// Rank stored embedding chunks against `query_vector` by cosine
    /// similarity and write the top matches as JSON. One result per entry,
    /// using that entry's best-scoring chunk as the snippet.
    pub fn semanticSearch(self: *Store, query_vector: []const f32, limit: i64, writer: *std.Io.Writer) !void {
        const take: usize = @intCast(@max(@min(limit, 25), 1));
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();

        var best = std.AutoHashMap(i64, SemanticHit).init(a);
        var last_entry: i64 = 0;
        var last_chunk: i64 = -1;
        var page_size: i64 = 32;
        while (true) {
            var rows = EmbeddingRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                \\SELECT journal_entry.id, journal_entry.entry_date, journal_entry.title,
                \\       entry_embedding.chunk_index, entry_embedding.chunk_text, entry_embedding.embedding
                \\FROM entry_embedding
                \\INNER JOIN journal_entry ON journal_entry.id = entry_embedding.entry_id
                \\WHERE entry_embedding.entry_id > ?1
                \\   OR (entry_embedding.entry_id = ?1 AND entry_embedding.chunk_index > ?2)
                \\ORDER BY entry_embedding.entry_id, entry_embedding.chunk_index
                \\LIMIT ?3;
            ,
                &.{ .{ .integer = last_entry }, .{ .integer = last_chunk }, .{ .integer = page_size } },
                &rows,
                EmbeddingRows.collect,
            );
            if (outcome == .rejected and page_size > 1) {
                page_size = @max(1, @divTrunc(page_size, 2));
                continue;
            }
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;

            for (rows.rows.items) |row| {
                last_entry = row.entry_id;
                last_chunk = row.chunk_index;
                const vec = decodeVectorAlloc(a, row.embedding) catch |err| switch (err) {
                    error.InvalidEmbedding => continue,
                    else => |e| return e,
                };
                if (vec.len != query_vector.len) continue;
                const score = cosineSimilarity(query_vector, vec);
                if (best.get(row.entry_id)) |hit| {
                    if (score <= hit.score) continue;
                }
                const title = try self.decryptFromStorage(vault_mod.aad_entry_title, row.title);
                defer self.allocator.free(title);
                const chunk_text = try self.decryptFromStorage(vault_mod.aad_chunk_text, row.chunk_text);
                defer self.allocator.free(chunk_text);
                try best.put(row.entry_id, .{
                    .id = row.entry_id,
                    .date = try a.dupe(u8, row.date),
                    .title = try a.dupe(u8, title),
                    .snippet = try a.dupe(u8, chunk_text),
                    .score = score,
                });
            }
        }

        var hits = std.ArrayList(SemanticHit).empty;
        var it = best.valueIterator();
        while (it.next()) |hit| try hits.append(a, hit.*);
        std.mem.sort(SemanticHit, hits.items, {}, SemanticHit.higherScore);

        try writer.writeAll("{\"entries\":[");
        const count = @min(hits.items.len, take);
        for (hits.items[0..count], 0..) |hit, index| {
            if (index > 0) try writer.writeAll(",");
            var snippet_buf: [240]u8 = undefined;
            const snippet = excerptLead(hit.snippet, &snippet_buf);
            try writer.writeAll("{\"id\":");
            try writer.print("{d}", .{hit.id});
            try writer.writeAll(",\"title\":");
            try writeJsonStringStreaming(writer, hit.title);
            try writer.writeAll(",\"date\":");
            try writeJsonStringStreaming(writer, hit.date);
            try writer.writeAll(",\"score\":");
            try writer.print("{d:.4}", .{hit.score});
            try writer.writeAll(",\"snippet\":");
            try writeJsonStringStreaming(writer, snippet);
            try writer.writeByte('}');
        }
        try writer.writeAll("]}");
    }

    /// Rank stored summary embeddings against `query_vector` by cosine
    /// similarity and write the top matches as JSON. One result per entry;
    /// the decrypted summary is the snippet.
    pub fn semanticSearchSummaries(self: *Store, query_vector: []const f32, limit: i64, writer: *std.Io.Writer) !void {
        const take: usize = @intCast(@max(@min(limit, 25), 1));
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();

        var hits = std.ArrayList(SemanticHit).empty;
        var last_id: i64 = 0;
        var page_size: i64 = 32;
        while (true) {
            var rows = EmbeddingRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                \\SELECT journal_entry.id, journal_entry.entry_date, journal_entry.title,
                \\       entry_summary.summary AS chunk_text, entry_summary.embedding
                \\FROM entry_summary
                \\INNER JOIN journal_entry ON journal_entry.id = entry_summary.entry_id
                \\WHERE entry_summary.entry_id > ?1
                \\ORDER BY entry_summary.entry_id
                \\LIMIT ?2;
            ,
                &.{ .{ .integer = last_id }, .{ .integer = page_size } },
                &rows,
                EmbeddingRows.collect,
            );
            if (outcome == .rejected and page_size > 1) {
                page_size = @max(1, @divTrunc(page_size, 2));
                continue;
            }
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;

            for (rows.rows.items) |row| {
                last_id = row.entry_id;
                const vec = decodeVectorAlloc(a, row.embedding) catch |err| switch (err) {
                    error.InvalidEmbedding => continue,
                    else => |e| return e,
                };
                if (vec.len != query_vector.len) continue;
                const score = cosineSimilarity(query_vector, vec);
                const title = try self.decryptFromStorage(vault_mod.aad_entry_title, row.title);
                defer self.allocator.free(title);
                const summary = try self.decryptFromStorage(vault_mod.aad_entry_summary, row.chunk_text);
                defer self.allocator.free(summary);
                try hits.append(a, .{
                    .id = row.entry_id,
                    .date = try a.dupe(u8, row.date),
                    .title = try a.dupe(u8, title),
                    .snippet = try a.dupe(u8, summary),
                    .score = score,
                });
            }
        }

        std.mem.sort(SemanticHit, hits.items, {}, SemanticHit.higherScore);

        try writer.writeAll("{\"entries\":[");
        const count = @min(hits.items.len, take);
        for (hits.items[0..count], 0..) |hit, index| {
            if (index > 0) try writer.writeAll(",");
            var snippet_buf: [240]u8 = undefined;
            const snippet = excerptLead(hit.snippet, &snippet_buf);
            try writer.writeAll("{\"id\":");
            try writer.print("{d}", .{hit.id});
            try writer.writeAll(",\"title\":");
            try writeJsonStringStreaming(writer, hit.title);
            try writer.writeAll(",\"date\":");
            try writeJsonStringStreaming(writer, hit.date);
            try writer.writeAll(",\"score\":");
            try writer.print("{d:.4}", .{hit.score});
            try writer.writeAll(",\"snippet\":");
            try writeJsonStringStreaming(writer, snippet);
            try writer.writeByte('}');
        }
        try writer.writeAll("]}");
    }

    pub fn chatList(self: *Store, output: []u8) ![]const u8 {
        var rows = ChatRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT id, title, updated_at FROM chat_conversation ORDER BY updated_at DESC, id DESC;",
            &.{},
            &rows,
            ChatRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"conversations\":[");
        for (rows.rows.items, 0..) |row, index| {
            if (index > 0) try writer.writeAll(",");
            const title = try self.decryptFromStorage(vault_mod.aad_chat_title, row.title);
            defer self.allocator.free(title);
            try writeChatMeta(&writer, row.id, title, row.updated_at);
        }
        try writer.writeAll("]}");
        return writer.buffered();
    }

    pub fn listChatExportMeta(self: *Store) ![]ChatExportMeta {
        var rows = ChatRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT id, title, eve_session_id, stream_index, created_at, updated_at, model, thinking, context_length FROM chat_conversation ORDER BY id;",
            &.{},
            &rows,
            ChatRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;

        const items = try self.allocator.alloc(ChatExportMeta, rows.rows.items.len);
        var initialized: usize = 0;
        errdefer {
            for (items[0..initialized]) |item| freeChatExportMetaItem(self.allocator, item);
            self.allocator.free(items);
        }

        for (rows.rows.items, 0..) |row, index| {
            items[index] = .{};
            initialized += 1;
            const title = try self.decryptFromStorage(vault_mod.aad_chat_title, row.title);
            items[index].title = title;
            if (row.eve_session_id.len > 0) {
                items[index].eve_session_id = try self.allocator.dupe(u8, row.eve_session_id);
            }
            items[index].context_length = row.context_length;
            items[index].created_at = try self.allocator.dupe(u8, row.created_at);
            items[index].id = row.id;
            items[index].model = try self.allocator.dupe(u8, row.model);
            items[index].stream_index = row.stream_index;
            items[index].thinking = if (row.thinking) |value| value != 0 else null;
            items[index].updated_at = try self.allocator.dupe(u8, row.updated_at);
        }
        return items;
    }

    pub fn freeChatExportMeta(self: *Store, items: []ChatExportMeta) void {
        for (items) |item| freeChatExportMetaItem(self.allocator, item);
        self.allocator.free(items);
    }

    pub fn chatExportEventPage(self: *Store, id: i64, offset: i64) !ChatExportEventPage {
        if (id <= 0 or offset < 0) return error.InvalidRequest;
        if (!try self.chatConversationExists(id)) return error.NotFound;
        const total = try self.chatEventCount(id);

        var rows = ChatEventRows.init(self.allocator);
        defer rows.deinit();
        if (offset < total) {
            const outcome = self.db.query(
                "SELECT seq, event FROM chat_event WHERE conversation_id = ?1 AND seq >= ?2 ORDER BY seq LIMIT 32;",
                &.{ .{ .integer = id }, .{ .integer = offset } },
                &rows,
                ChatEventRows.collect,
            );
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
        }

        var events: std.ArrayList([]u8) = .empty;
        errdefer {
            for (events.items) |event| self.allocator.free(event);
            events.deinit(self.allocator);
        }
        var next_seq = offset;
        for (rows.rows.items) |row| {
            var aad_buf: [80]u8 = undefined;
            const aad = chatEventAad(&aad_buf, id, row.seq);
            const plaintext = try self.decryptFromStorage(aad, row.event);
            events.append(self.allocator, plaintext) catch |err| {
                self.allocator.free(plaintext);
                return err;
            };
            next_seq = row.seq + 1;
        }
        if (events.items.len == 0 and offset < total) return error.ChatEventPageMissing;
        return .{
            .done = next_seq >= total,
            .events = try events.toOwnedSlice(self.allocator),
            .next_seq = next_seq,
        };
    }

    /// Latest journal entry plus entries and conversations on or after
    /// `sinceDate` (`yyyy-MM-dd`). List snippets are plaintext with
    /// whitespace collapsed. The latest snippet keeps markdown so Home can
    /// strip formatting. Conversation snippets use the first assistant message.
    pub fn homeFeed(self: *Store, payload: []const u8, output: []u8) ![]const u8 {
        var string_buf: [32]u8 = undefined;
        var used: usize = 0;
        const since_date = jsonString(payload, "sinceDate", &string_buf, &used) orelse return error.InvalidRequest;
        if (!isCalendarDate(since_date)) return error.InvalidRequest;

        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();

        const latest = try self.homeLatestEntry(a);
        var items: std.ArrayList(HomeFeedItem) = .empty;
        try self.collectHomeEntries(a, &items, since_date);
        try self.collectHomeConversations(a, &items, since_date);
        std.mem.sort(HomeFeedItem, items.items, {}, HomeFeedItem.newerFirst);

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"latest\":");
        if (latest) |row| {
            try writeHomeLatest(&writer, row);
        } else {
            try writer.writeAll("null");
        }
        try writer.writeAll(",\"items\":[");
        for (items.items, 0..) |item, index| {
            if (index > 0) try writer.writeAll(",");
            try writeHomeItem(&writer, item);
        }
        try writer.writeAll("]}");
        return writer.buffered();
    }

    fn homeLatestEntry(self: *Store, arena: std.mem.Allocator) !?HomeLatest {
        var rows = QueryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT id, entry_date, title, word_count, body_format, updated_at FROM journal_entry ORDER BY entry_date DESC, id DESC LIMIT 1;",
            &.{},
            &rows,
            QueryRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        if (rows.rows.items.len == 0) return null;
        return try self.homeEntryFromRow(arena, rows.rows.items[0], home_latest_snippet_window, .keep_breaks);
    }

    fn collectHomeEntries(
        self: *Store,
        arena: std.mem.Allocator,
        items: *std.ArrayList(HomeFeedItem),
        since_date: []const u8,
    ) !void {
        var rows = QueryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT id, entry_date, title, word_count, body_format, updated_at FROM journal_entry WHERE entry_date >= ?1 ORDER BY entry_date DESC, id DESC;",
            &.{.{ .text = since_date }},
            &rows,
            QueryRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        for (rows.rows.items) |row| {
            const latest = try self.homeEntryFromRow(arena, row, excerpt_window, .collapse);
            try items.append(arena, .{
                .kind = .entry,
                .id = latest.id,
                .title = latest.title,
                .date = latest.date,
                .snippet = latest.snippet,
                .sort_at = try homeEntrySortAt(arena, latest.date),
            });
        }
    }

    fn collectHomeConversations(
        self: *Store,
        arena: std.mem.Allocator,
        items: *std.ArrayList(HomeFeedItem),
        since_date: []const u8,
    ) !void {
        var rows = ChatRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT id, title, updated_at FROM chat_conversation WHERE updated_at >= ?1 ORDER BY updated_at DESC, id DESC;",
            &.{.{ .text = since_date }},
            &rows,
            ChatRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        for (rows.rows.items) |row| {
            const title = try self.decryptFromStorage(vault_mod.aad_chat_title, row.title);
            defer self.allocator.free(title);
            const assistant = try self.firstAssistantText(row.id);
            defer self.allocator.free(assistant);
            const date = calendarDatePrefix(row.updated_at);
            try items.append(arena, .{
                .kind = .conversation,
                .id = row.id,
                .title = try arena.dupe(u8, title),
                .date = try arena.dupe(u8, date),
                .snippet = try homeSnippet(arena, assistant, excerpt_window),
                .sort_at = try arena.dupe(u8, row.updated_at),
            });
        }
    }

    fn homeEntryFromRow(
        self: *Store,
        arena: std.mem.Allocator,
        row: QueryRows.Row,
        window: usize,
        snippet_mode: HomeSnippetMode,
    ) !HomeLatest {
        const title = try self.decryptFromStorage(vault_mod.aad_entry_title, row.title);
        defer self.allocator.free(title);
        const stored_body = try self.loadStoredColumn("journal_entry", "body", row.id);
        defer self.allocator.free(stored_body);
        const body = try self.decryptFromStorage(vault_mod.aad_entry_body, stored_body);
        defer self.allocator.free(body);
        const plain = try ollama.extractPlainText(self.allocator, body, row.format);
        defer self.allocator.free(plain);
        const snippet = switch (snippet_mode) {
            .collapse => try homeSnippet(arena, plain, window),
            .keep_breaks => try homeLead(arena, plain, window),
        };
        return .{
            .id = row.id,
            .title = try arena.dupe(u8, title),
            .date = try arena.dupe(u8, row.date),
            .word_count = row.word_count,
            .format = try arena.dupe(u8, row.format),
            .snippet = snippet,
            .updated_at = try arena.dupe(u8, row.updated_at),
        };
    }

    fn firstAssistantText(self: *Store, conversation_id: i64) ![]u8 {
        var last_seq: i64 = -1;
        var event_page: i64 = 32;
        while (true) {
            var event_rows = ChatEventRows.init(self.allocator);
            defer event_rows.deinit();
            const outcome = self.db.query(
                "SELECT seq, event FROM chat_event WHERE conversation_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3;",
                &.{ .{ .integer = conversation_id }, .{ .integer = last_seq }, .{ .integer = event_page } },
                &event_rows,
                ChatEventRows.collect,
            );
            if (outcome == .rejected and event_page > 1) {
                event_page = @max(1, @divTrunc(event_page, 2));
                continue;
            }
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (event_rows.failed) return error.SqlitePageFailed;
            if (event_rows.rows.items.len == 0) break;
            for (event_rows.rows.items) |event_row| {
                last_seq = event_row.seq;
                var aad_buf: [80]u8 = undefined;
                const aad = chatEventAad(&aad_buf, conversation_id, event_row.seq);
                const plaintext = try self.decryptFromStorage(aad, event_row.event);
                defer self.allocator.free(plaintext);
                if (try self.assistantTextFromEvent(plaintext)) |text| return text;
            }
        }
        return self.allocator.dupe(u8, "");
    }

    fn assistantTextFromEvent(self: *Store, raw: []const u8) !?[]u8 {
        var parsed = std.json.parseFromSlice(std.json.Value, self.allocator, raw, .{ .allocate = .alloc_always }) catch return null;
        defer parsed.deinit();
        const extracted = readChatEventText(parsed.value) orelse return null;
        if (extracted.role != .assistant) return null;
        return try self.allocator.dupe(u8, extracted.text);
    }

    pub fn chatSearch(self: *Store, payload: []const u8, output: []u8) ![]const u8 {
        var string_buf: [4096]u8 = undefined;
        var used: usize = 0;
        const query = jsonString(payload, "query", &string_buf, &used) orelse return error.InvalidRequest;
        if (query.len == 0) {
            var empty = std.Io.Writer.fixed(output);
            try empty.writeAll("{\"hits\":[]}");
            return empty.buffered();
        }

        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();

        var matches: std.ArrayList(ChatSearchMatch) = .empty;
        var last_id: i64 = 0;
        var page_size: i64 = 32;
        while (true) {
            var rows = ChatRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                "SELECT id, title, updated_at FROM chat_conversation WHERE id > ?1 ORDER BY id LIMIT ?2;",
                &.{ .{ .integer = last_id }, .{ .integer = page_size } },
                &rows,
                ChatRows.collect,
            );
            if (outcome == .rejected and page_size > 1) {
                page_size = @max(1, @divTrunc(page_size, 2));
                continue;
            }
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_id = row.id;
                try self.collectChatSearchHits(a, &matches, row, query);
            }
        }

        std.mem.sort(ChatSearchMatch, matches.items, {}, ChatSearchMatch.newerFirst);

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"hits\":[");
        for (matches.items[0..@min(matches.items.len, chat_search_max_hits)], 0..) |match, index| {
            if (index > 0) try writer.writeAll(",");
            try writeChatSearchHit(&writer, match);
        }
        try writer.writeAll("]}");
        return writer.buffered();
    }

    fn collectChatSearchHits(
        self: *Store,
        arena: std.mem.Allocator,
        matches: *std.ArrayList(ChatSearchMatch),
        row: ChatRows.Row,
        query: []const u8,
    ) !void {
        const title = try self.decryptFromStorage(vault_mod.aad_chat_title, row.title);
        defer self.allocator.free(title);
        const title_copy = try arena.dupe(u8, title);
        const updated_at = try arena.dupe(u8, row.updated_at);
        const title_match = std.ascii.indexOfIgnoreCase(title, query) != null;

        const before = matches.items.len;
        var last_seq: i64 = -1;
        var event_page: i64 = 32;
        while (true) {
            var event_rows = ChatEventRows.init(self.allocator);
            defer event_rows.deinit();
            const outcome = self.db.query(
                "SELECT seq, event FROM chat_event WHERE conversation_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3;",
                &.{ .{ .integer = row.id }, .{ .integer = last_seq }, .{ .integer = event_page } },
                &event_rows,
                ChatEventRows.collect,
            );
            if (outcome == .rejected and event_page > 1) {
                event_page = @max(1, @divTrunc(event_page, 2));
                continue;
            }
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (event_rows.failed) return error.SqlitePageFailed;
            if (event_rows.rows.items.len == 0) break;
            for (event_rows.rows.items) |event_row| {
                last_seq = event_row.seq;
                var aad_buf: [80]u8 = undefined;
                const aad = chatEventAad(&aad_buf, row.id, event_row.seq);
                const plaintext = try self.decryptFromStorage(aad, event_row.event);
                defer self.allocator.free(plaintext);
                try self.matchChatSearchEvent(arena, matches, row.id, event_row.seq, plaintext, query, title_copy, updated_at);
            }
        }

        capNewestMessageHits(matches, before, chat_search_hits_per_conversation);
        try self.finishTitleOnlyHit(arena, matches, before, row.id, title_copy, updated_at, title, query, title_match);
    }

    fn finishTitleOnlyHit(
        self: *Store,
        arena: std.mem.Allocator,
        matches: *std.ArrayList(ChatSearchMatch),
        before: usize,
        conversation_id: i64,
        title: []const u8,
        updated_at: []const u8,
        title_plain: []const u8,
        query: []const u8,
        title_match: bool,
    ) !void {
        _ = self;
        if (!title_match or matches.items.len > before) return;
        const excerpt_buf = try arena.alloc(u8, 160);
        try matches.append(arena, .{
            .conversation_id = conversation_id,
            .excerpt = excerptFor(title_plain, "", query, excerpt_buf),
            .role = null,
            .seq = null,
            .title = title,
            .updated_at = updated_at,
        });
    }

    fn matchChatSearchEvent(
        self: *Store,
        arena: std.mem.Allocator,
        matches: *std.ArrayList(ChatSearchMatch),
        conversation_id: i64,
        seq: i64,
        raw: []const u8,
        query: []const u8,
        title: []const u8,
        updated_at: []const u8,
    ) !void {
        var parsed = std.json.parseFromSlice(std.json.Value, self.allocator, raw, .{ .allocate = .alloc_always }) catch return;
        defer parsed.deinit();
        const extracted = readChatEventText(parsed.value) orelse return;
        if (std.ascii.indexOfIgnoreCase(extracted.text, query) == null) return;
        const excerpt_buf = try arena.alloc(u8, 160);
        try matches.append(arena, .{
            .conversation_id = conversation_id,
            .excerpt = excerptFor("", extracted.text, query, excerpt_buf),
            .role = extracted.role,
            .seq = seq,
            .title = title,
            .updated_at = updated_at,
        });
    }

    pub fn chatGet(self: *Store, payload: []const u8, output: []u8) ![]const u8 {
        const id = jsonI64(payload, "id") orelse return error.InvalidRequest;
        const offset = jsonI64(payload, "offset") orelse 0;
        if (offset < 0) return error.InvalidRequest;

        var rows = ChatRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT id, title, eve_session_id, stream_index, created_at, updated_at, model, thinking, context_length FROM chat_conversation WHERE id = ?1;",
            &.{.{ .integer = id }},
            &rows,
            ChatRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        if (rows.rows.items.len == 0) return error.NotFound;

        const row = rows.rows.items[0];
        const title = try self.decryptFromStorage(vault_mod.aad_chat_title, row.title);
        defer self.allocator.free(title);
        const total = try self.chatEventCount(id);

        var event_rows = ChatEventRows.init(self.allocator);
        defer event_rows.deinit();
        if (offset < total) {
            // One query's staged result caps at 8 MiB. 32 rows fit even at
            // the 256 KiB row cap, and the response budget below usually
            // ends a page earlier.
            const events_outcome = self.db.query(
                "SELECT seq, event FROM chat_event WHERE conversation_id = ?1 AND seq >= ?2 ORDER BY seq LIMIT 32;",
                &.{ .{ .integer = id }, .{ .integer = offset } },
                &event_rows,
                ChatEventRows.collect,
            );
            if (events_outcome != .ok) return error.SqliteQueryFailed;
            if (event_rows.failed) return error.SqlitePageFailed;
        }

        const events_budget: usize = if (output.len > 8192)
            @min(chat_read_events_budget, output.len - 4096)
        else
            output.len / 2;

        var opened: std.ArrayList([]u8) = .empty;
        defer {
            for (opened.items) |item| self.allocator.free(item);
            opened.deinit(self.allocator);
        }

        var events_bytes: usize = 0;
        var next_seq: i64 = offset;
        for (event_rows.rows.items) |event_row| {
            var aad_buf: [80]u8 = undefined;
            const aad = chatEventAad(&aad_buf, id, event_row.seq);
            const plaintext = try self.decryptFromStorage(aad, event_row.event);
            const extra = plaintext.len + if (opened.items.len > 0) @as(usize, 1) else 0;
            if (opened.items.len > 0 and events_bytes + extra > events_budget) {
                self.allocator.free(plaintext);
                break;
            }
            opened.append(self.allocator, plaintext) catch |err| {
                self.allocator.free(plaintext);
                return err;
            };
            events_bytes += extra;
            next_seq = event_row.seq + 1;
        }
        const done = next_seq >= total;

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"id\":");
        try writer.print("{d}", .{row.id});
        try writer.writeAll(",\"title\":");
        try writeJsonString(&writer, title);
        try writer.writeAll(",\"eveSessionId\":");
        if (row.eve_session_id.len == 0)
            try writer.writeAll("null")
        else
            try writeJsonString(&writer, row.eve_session_id);
        try writer.writeAll(",\"streamIndex\":");
        try writer.print("{d}", .{row.stream_index});
        try writer.writeAll(",\"model\":");
        try writeJsonString(&writer, row.model);
        try writer.writeAll(",\"thinking\":");
        try writeChatThinking(&writer, row.thinking);
        try writer.writeAll(",\"contextLength\":");
        try writeChatContextLength(&writer, row.context_length);
        try writer.writeAll(",\"createdAt\":");
        try writeJsonString(&writer, row.created_at);
        try writer.writeAll(",\"updatedAt\":");
        try writeJsonString(&writer, row.updated_at);
        try writer.writeAll(",\"events\":[");
        for (opened.items, 0..) |event, index| {
            if (index > 0) try writer.writeByte(',');
            try writer.writeAll(event);
        }
        try writer.writeAll("],\"nextSeq\":");
        try writer.print("{d}", .{next_seq});
        try writer.writeAll(",\"done\":");
        try writer.writeAll(if (done) "true" else "false");
        try writer.writeByte('}');
        return writer.buffered();
    }

    pub fn chatSave(self: *Store, payload: []const u8, output: []u8) ![]const u8 {
        var string_buf: [128 * 1024]u8 = undefined;
        var used: usize = 0;
        const title = jsonString(payload, "title", &string_buf, &used) orelse return error.InvalidRequest;
        const chunk = jsonString(payload, "chunk", &string_buf, &used) orelse return error.InvalidRequest;
        const offset: usize = @intCast(jsonI64(payload, "offset") orelse 0);
        const done = jsonBool(payload, "done") orelse false;
        const stream_index = jsonI64(payload, "streamIndex") orelse 0;
        const new_row = jsonIsNull(payload, "id") or jsonRaw(payload, "id") == null;
        const id = if (new_row) 0 else jsonI64(payload, "id") orelse return error.InvalidRequest;
        const has_session = !(jsonIsNull(payload, "eveSessionId") or jsonRaw(payload, "eveSessionId") == null);
        const session_id = if (has_session)
            jsonString(payload, "eveSessionId", &string_buf, &used) orelse return error.InvalidRequest
        else
            "";
        const base_seq = jsonI64(payload, "baseSeq") orelse 0;
        defer if (done) self.resetPendingChatSave();
        const has_model = !(jsonIsNull(payload, "model") or jsonRaw(payload, "model") == null);
        const model = if (has_model)
            jsonString(payload, "model", &string_buf, &used) orelse return error.InvalidRequest
        else
            "";
        const thinking = try readChatThinking(payload);
        const context_length = jsonI64(payload, "contextLength");

        if (offset == 0) {
            if (base_seq < 0) return error.InvalidSaveChunk;
            if (new_row and base_seq != 0) return error.InvalidSaveChunk;
            self.chat_save_events.clearRetainingCapacity();
            self.chat_save_title.clearRetainingCapacity();
            self.chat_save_session.clearRetainingCapacity();
            self.chat_save_model.clearRetainingCapacity();
            try self.chat_save_title.appendSlice(self.allocator, title);
            if (has_session) try self.chat_save_session.appendSlice(self.allocator, session_id);
            if (has_model) try self.chat_save_model.appendSlice(self.allocator, model);
            self.chat_save_thinking = thinking;
            self.chat_save_context_length = context_length;
            self.chat_save_active = true;
            self.chat_save_new = new_row;
            self.chat_save_has_session = has_session;
            self.chat_save_id = id;
            self.chat_save_stream_index = stream_index;
            self.chat_save_base_seq = base_seq;
            self.chat_save_generation = self.chat_write_generation;
        } else if (self.chat_save_generation != self.chat_write_generation) {
            self.resetPendingChatSave();
            return error.InvalidSaveChunk;
        } else if (!self.chat_save_active or self.chat_save_new != new_row or self.chat_save_id != id or offset != self.chat_save_events.items.len) {
            return error.InvalidSaveChunk;
        }

        try self.chat_save_events.appendSlice(self.allocator, chunk);
        if (!done) {
            var writer = std.Io.Writer.fixed(output);
            try writer.writeAll("{\"id\":");
            if (new_row) try writer.writeAll("null") else try writer.print("{d}", .{id});
            try writer.writeAll(",\"done\":false}");
            return writer.buffered();
        }

        const elements = try splitJsonArrayElements(self.allocator, self.chat_save_events.items);
        defer self.allocator.free(elements);
        // Reject before any write: an oversized event would store a row that
        // reads cannot page back, and checking up front keeps the save atomic.
        for (elements) |element| {
            if (element.len > chat_event_max_plaintext_bytes) return error.ChatEventTooLarge;
        }

        const written_id = if (new_row) blk: {
            const created_id = try self.insertChat(
                self.chat_save_title.items,
                if (self.chat_save_has_session) self.chat_save_session.items else null,
                self.chat_save_stream_index,
                self.chat_save_model.items,
                self.chat_save_thinking,
                self.chat_save_context_length,
            );
            try self.insertChatEventRange(created_id, 0, elements, &.{});
            break :blk created_id;
        } else blk: {
            if (!try self.chatConversationExists(id)) return error.NotFound;
                try self.replaceChatTail(
                id,
                if (self.chat_save_has_session) self.chat_save_session.items else null,
                self.chat_save_stream_index,
                self.chat_save_model.items,
                self.chat_save_thinking,
                self.chat_save_context_length,
                self.chat_save_base_seq,
                elements,
            );
            break :blk id;
        };

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"id\":");
        try writer.print("{d}", .{written_id});
        try writer.writeAll("}");
        return writer.buffered();
    }

    pub fn chatDelete(self: *Store, payload: []const u8, output: []u8, session_id_buf: []u8) !ChatDeleteResult {
        const id = jsonI64(payload, "id") orelse return error.InvalidRequest;

        var session_id: ?[]const u8 = null;
        var json_session: []const u8 = "";
        var rows = ChatRows.init(self.allocator);
        defer rows.deinit();
        const lookup = self.db.query(
            "SELECT eve_session_id FROM chat_conversation WHERE id = ?1;",
            &.{.{ .integer = id }},
            &rows,
            ChatRows.collect,
        );
        if (lookup == .ok and !rows.failed and rows.rows.items.len > 0) {
            const stored = rows.rows.items[0].eve_session_id;
            if (stored.len > 0) {
                json_session = stored;
                if (stored.len <= session_id_buf.len) {
                    @memcpy(session_id_buf[0..stored.len], stored);
                    session_id = session_id_buf[0..stored.len];
                    json_session = session_id.?;
                }
            }
        }

        const outcome = self.db.exec(&.{
            .{
                .sql = "DELETE FROM chat_event WHERE conversation_id = ?1;",
                .params = &.{.{ .integer = id }},
            },
            .{
                .sql = "DELETE FROM chat_index_skip WHERE conversation_id = ?1;",
                .params = &.{.{ .integer = id }},
            },
            .{
                .sql = "DELETE FROM chat_conversation WHERE id = ?1;",
                .params = &.{.{ .integer = id }},
            },
            .{
                .sql = "DELETE FROM semantic_fact WHERE source_type = ?1 AND source_id = ?2;",
                .params = &.{ .{ .text = DreamSource.conversation.sqlName() }, .{ .integer = id } },
            },
            .{
                .sql = "DELETE FROM episodic_event WHERE source_type = ?1 AND source_id = ?2;",
                .params = &.{ .{ .text = DreamSource.conversation.sqlName() }, .{ .integer = id } },
            },
            .{
                .sql = "DELETE FROM dream_state WHERE source_type = ?1 AND source_id = ?2;",
                .params = &.{ .{ .text = DreamSource.conversation.sqlName() }, .{ .integer = id } },
            },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;
        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"ok\":true,\"eveSessionId\":");
        if (json_session.len == 0)
            try writer.writeAll("null")
        else
            try writeJsonString(&writer, json_session);
        try writer.writeByte('}');
        return .{ .json = writer.buffered(), .session_id = session_id };
    }

    /// Every stored eve session id. Used to sweep orphaned workflow files.
    /// The caller owns the slice and each id.
    pub fn chatSessionIds(self: *Store, allocator: std.mem.Allocator) ![][]const u8 {
        var rows = ChatRows.init(self.allocator);
        defer rows.deinit();
        const lookup = self.db.query(
            "SELECT eve_session_id FROM chat_conversation WHERE eve_session_id IS NOT NULL;",
            &.{},
            &rows,
            ChatRows.collect,
        );
        if (lookup != .ok or rows.failed) return error.SqliteReadFailed;

        var collected: std.ArrayList([]const u8) = .empty;
        errdefer {
            for (collected.items) |id| allocator.free(id);
            collected.deinit(allocator);
        }
        for (rows.rows.items) |row| {
            if (row.eve_session_id.len == 0) continue;
            const copy = try allocator.dupe(u8, row.eve_session_id);
            try collected.append(allocator, copy);
        }
        if (collected.items.len == 0) {
            collected.deinit(allocator);
            return &.{};
        }
        return collected.toOwnedSlice(allocator);
    }

    pub fn chatSavePrefs(self: *Store, payload: []const u8, output: []u8) ![]const u8 {
        var string_buf: [512]u8 = undefined;
        var used: usize = 0;
        const id = jsonI64(payload, "id") orelse return error.InvalidRequest;
        const model = jsonString(payload, "model", &string_buf, &used) orelse return error.InvalidRequest;
        if (jsonRaw(payload, "thinking") == null) return error.InvalidRequest;
        const thinking = try readChatThinking(payload);

        if (!try self.chatConversationExists(id)) return error.NotFound;

        const outcome = self.db.exec(&.{.{
            .sql = "UPDATE chat_conversation SET model = ?1, thinking = ?2 WHERE id = ?3;",
            .params = &.{
                .{ .text = model },
                chatThinkingValue(thinking),
                .{ .integer = id },
            },
        }});
        if (outcome != .ok) return error.SqliteWriteFailed;
        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"ok\":true}");
        return writer.buffered();
    }

    pub fn chatRename(self: *Store, payload: []const u8, output: []u8) ![]const u8 {
        var string_buf: [512]u8 = undefined;
        var used: usize = 0;
        const id = jsonI64(payload, "id") orelse return error.InvalidRequest;
        const title = jsonString(payload, "title", &string_buf, &used) orelse return error.InvalidRequest;

        if (!try self.chatConversationExists(id)) return error.NotFound;

        const stored_title = try self.encryptForStorage(vault_mod.aad_chat_title, title);
        defer self.allocator.free(stored_title);
        const outcome = self.db.exec(&.{.{
            .sql = "UPDATE chat_conversation SET title = ?1, title_locked = 1 WHERE id = ?2;",
            .params = &.{
                .{ .text = stored_title },
                .{ .integer = id },
            },
        }});
        if (outcome != .ok) return error.SqliteWriteFailed;
        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"ok\":true}");
        return writer.buffered();
    }

    /// Write a Dream-generated title when the chat is not locked. Leaves
    /// `updated_at` alone so the sidebar order does not change. A locked
    /// row is a no-op.
    pub fn applyDreamChatTitle(self: *Store, id: i64, title: []const u8) !void {
        if (title.len == 0) return;
        const stored_title = try self.encryptForStorage(vault_mod.aad_chat_title, title);
        defer self.allocator.free(stored_title);
        const outcome = self.db.exec(&.{.{
            .sql = "UPDATE chat_conversation SET title = ?1 WHERE id = ?2 AND title_locked = 0;",
            .params = &.{
                .{ .text = stored_title },
                .{ .integer = id },
            },
        }});
        if (outcome != .ok) return error.SqliteWriteFailed;
    }

    fn insertChat(
        self: *Store,
        title: []const u8,
        session_id: ?[]const u8,
        stream_index: i64,
        model: []const u8,
        thinking: ?bool,
        context_length: ?i64,
    ) !i64 {
        const stored_title = try self.encryptForStorage(vault_mod.aad_chat_title, title);
        defer self.allocator.free(stored_title);
        const insert_outcome = self.db.exec(&.{.{
            .sql = "INSERT INTO chat_conversation (title, eve_session_id, stream_index, events, model, thinking, context_length) VALUES (?1, ?2, ?3, '', ?4, ?5, ?6);",
            .params = &.{
                .{ .text = stored_title },
                if (session_id) |value| .{ .text = value } else .null_value,
                .{ .integer = stream_index },
                .{ .text = model },
                chatThinkingValue(thinking),
                chatContextLengthValue(context_length),
            },
        }});
        if (insert_outcome != .ok) return error.SqliteWriteFailed;

        var rows = ChatRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT MAX(id) AS id FROM chat_conversation;",
            &.{},
            &rows,
            ChatRows.collect,
        );
        if (outcome != .ok or rows.failed or rows.rows.items.len == 0) return error.SqliteQueryFailed;
        return rows.rows.items[0].id;
    }

    fn chatConversationExists(self: *Store, id: i64) !bool {
        var rows = ChatRows.init(self.allocator);
        defer rows.deinit();
        const found = self.db.query(
            "SELECT id FROM chat_conversation WHERE id = ?1;",
            &.{.{ .integer = id }},
            &rows,
            ChatRows.collect,
        );
        if (found != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        return rows.rows.items.len > 0;
    }

    fn replaceChatTail(
        self: *Store,
        id: i64,
        session_id: ?[]const u8,
        stream_index: i64,
        model: []const u8,
        thinking: ?bool,
        context_length: ?i64,
        base_seq: i64,
        elements: []const []const u8,
    ) !void {
        const count = try self.chatEventCount(id);
        if (base_seq > count) return error.InvalidSaveChunk;

        const events_changed = base_seq < count or elements.len > 0;
        const update_params = [_]native_sdk.relational_store.Value{
            if (session_id) |value| .{ .text = value } else .null_value,
            .{ .integer = stream_index },
            .{ .text = model },
            chatThinkingValue(thinking),
            chatContextLengthValue(context_length),
            .{ .integer = id },
        };
        if (!events_changed) {
            const outcome = self.db.exec(&.{.{
                .sql = "UPDATE chat_conversation SET eve_session_id = ?1, stream_index = ?2, model = ?3, thinking = ?4, context_length = COALESCE(context_length, ?5) WHERE id = ?6;",
                .params = &update_params,
            }});
            if (outcome != .ok) return error.SqliteWriteFailed;
            return;
        }
        const delete_params = [_]native_sdk.relational_store.Value{
            .{ .integer = id },
            .{ .integer = base_seq },
        };
        const prefix = [_]native_sdk.relational_store.Statement{
            .{
                .sql = "UPDATE chat_conversation SET eve_session_id = ?1, stream_index = ?2, model = ?3, thinking = ?4, context_length = COALESCE(context_length, ?5), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?6;",
                .params = &update_params,
            },
            .{
                .sql = "DELETE FROM chat_event WHERE conversation_id = ?1 AND seq >= ?2;",
                .params = &delete_params,
            },
            .{
                .sql = "DELETE FROM chat_index_skip WHERE conversation_id = ?1;",
                .params = &.{.{ .integer = id }},
            },
        };
        try self.insertChatEventRange(id, base_seq, elements, &prefix);
    }

    fn chatEventCount(self: *Store, conversation_id: i64) !i64 {
        var counts = CountRows{};
        const outcome = self.db.query(
            "SELECT COUNT(*) AS n FROM chat_event WHERE conversation_id = ?1;",
            &.{.{ .integer = conversation_id }},
            &counts,
            CountRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (counts.failed) return error.SqlitePageFailed;
        return counts.value;
    }

    fn encryptChatEvent(self: *Store, conversation_id: i64, seq: i64, plaintext: []const u8) ![]u8 {
        var aad_buf: [80]u8 = undefined;
        const aad = chatEventAad(&aad_buf, conversation_id, seq);
        return self.encryptForStorage(aad, plaintext);
    }

    fn insertChatEventRange(
        self: *Store,
        conversation_id: i64,
        base_seq: i64,
        elements: []const []const u8,
        prefix: []const native_sdk.relational_store.Statement,
    ) !void {
        const max_statements = native_sdk.relational_store.max_exec_statements;
        var index: usize = 0;
        var first = true;
        while (true) {
            if (!first and index >= elements.len) break;
            if (first and prefix.len == 0 and elements.len == 0) break;

            const reserved: usize = if (first) prefix.len else 0;
            var writes: std.ArrayList(ChatEventWrite) = .empty;
            defer {
                for (writes.items) |item| self.allocator.free(item.stored);
                writes.deinit(self.allocator);
            }

            var param_bytes: usize = 0;
            const insert_room = max_statements - reserved;
            while (index < elements.len and writes.items.len < insert_room) {
                const seq = base_seq + @as(i64, @intCast(index));
                const stored = try self.encryptChatEvent(conversation_id, seq, elements[index]);
                if (writes.items.len > 0 and param_bytes + stored.len > chat_event_insert_bytes) {
                    self.allocator.free(stored);
                    break;
                }
                writes.append(self.allocator, .{
                    .params = .{
                        .{ .integer = conversation_id },
                        .{ .integer = seq },
                        .{ .text = stored },
                    },
                    .stored = stored,
                }) catch |err| {
                    self.allocator.free(stored);
                    return err;
                };
                param_bytes += stored.len;
                index += 1;
            }

            var statements: std.ArrayList(native_sdk.relational_store.Statement) = .empty;
            defer statements.deinit(self.allocator);
            if (first) try statements.appendSlice(self.allocator, prefix);
            for (writes.items) |*item| {
                try statements.append(self.allocator, .{
                    .sql = chat_event_insert_sql,
                    .params = item.params[0..],
                });
            }
            first = false;
            if (statements.items.len == 0) break;
            if (self.db.exec(statements.items) != .ok) return error.SqliteWriteFailed;
            if (index >= elements.len) break;
        }
    }

    /// Read one TEXT/BLOB column in byte slices that fit a query page.
    /// SQLite `substr` on a BLOB is 1-based and counts bytes, so we CAST first.
    fn loadStoredColumn(self: *Store, comptime table: []const u8, comptime column: []const u8, id: i64) ![]u8 {
        const length_sql = "SELECT length(CAST(" ++ column ++ " AS BLOB)) AS n FROM " ++ table ++ " WHERE id = ?1;";
        const slice_sql = "SELECT substr(CAST(" ++ column ++ " AS BLOB), ?2, ?3) AS chunk FROM " ++ table ++ " WHERE id = ?1;";

        var counts = CountRows{};
        const len_outcome = self.db.query(
            length_sql,
            &.{.{ .integer = id }},
            &counts,
            CountRows.collect,
        );
        if (len_outcome != .ok) return error.SqliteQueryFailed;
        if (counts.failed) return error.SqlitePageFailed;
        if (!counts.found) return error.NotFound;
        if (counts.value < 0) return error.SqlitePageFailed;
        const total: usize = @intCast(counts.value);
        if (total == 0) return self.allocator.dupe(u8, "");

        const stored = try self.allocator.alloc(u8, total);
        errdefer self.allocator.free(stored);
        var at: usize = 0;
        while (at < total) {
            const want: i64 = @intCast(@min(stored_column_read_bytes, total - at));
            const start: i64 = @intCast(at + 1);
            var slice = BlobSliceRows.init(self.allocator);
            defer slice.deinit();
            const outcome = self.db.query(
                slice_sql,
                &.{ .{ .integer = id }, .{ .integer = start }, .{ .integer = want } },
                &slice,
                BlobSliceRows.collect,
            );
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (slice.failed) return error.SqlitePageFailed;
            if (slice.bytes.len == 0) return error.SqlitePageFailed;
            if (at + slice.bytes.len > stored.len) return error.SqlitePageFailed;
            @memcpy(stored[at .. at + slice.bytes.len], slice.bytes);
            at += slice.bytes.len;
        }
        if (at != total) return error.SqlitePageFailed;
        return stored;
    }

    pub fn save(self: *Store, payload: []const u8, output: []u8) ![]const u8 {
        var string_buf: [128 * 1024]u8 = undefined;
        var used: usize = 0;
        const title = jsonString(payload, "title", &string_buf, &used) orelse return error.InvalidRequest;
        const date = jsonString(payload, "date", &string_buf, &used) orelse return error.InvalidRequest;
        const format = jsonString(payload, "format", &string_buf, &used) orelse return error.InvalidRequest;
        const chunk = jsonString(payload, "chunk", &string_buf, &used) orelse return error.InvalidRequest;
        const word_count = jsonI64(payload, "wordCount") orelse return error.InvalidRequest;
        const offset = std.math.cast(usize, jsonI64(payload, "offset") orelse 0) orelse return error.InvalidSaveChunk;
        const done = jsonBool(payload, "done") orelse false;
        defer if (done) self.resetPendingJournalSave();
        const new_entry = jsonIsNull(payload, "id") or jsonRaw(payload, "id") == null;
        const id = if (new_entry) 0 else jsonI64(payload, "id") orelse return error.InvalidRequest;

        if (offset == 0) {
            if (chunk.len > max_save_body_bytes) return error.TooLarge;
            self.clearSaveBody();
            self.save_active = true;
            self.save_new = new_entry;
            self.save_id = id;
            self.save_generation = self.journal_write_generation;
        } else {
            if (self.save_generation != self.journal_write_generation) {
                self.resetPendingJournalSave();
                return error.InvalidSaveChunk;
            }
            if (!self.save_active or self.save_new != new_entry or self.save_id != id or offset != self.save_body.items.len) {
                return error.InvalidSaveChunk;
            }
            if (self.save_body.items.len > max_save_body_bytes) return error.TooLarge;
            if (chunk.len > max_save_body_bytes - self.save_body.items.len) return error.TooLarge;
        }

        try self.save_body.appendSlice(self.allocator, chunk);
        if (!done) {
            var writer = std.Io.Writer.fixed(output);
            try writer.writeAll("{\"id\":");
            if (new_entry) try writer.writeAll("null") else try writer.print("{d}", .{id});
            try writer.writeAll(",\"done\":false}");
            return writer.buffered();
        }

        const body = self.save_body.items;
        const written_id = if (new_entry)
            try self.insertEntry(date, title, body, word_count, format)
        else blk: {
            try self.updateEntry(id, date, title, body, word_count, format);
            break :blk id;
        };

        var updated_rows = QueryRows.init(self.allocator);
        defer updated_rows.deinit();
        const updated_outcome = self.db.query(
            "SELECT updated_at FROM journal_entry WHERE id = ?1;",
            &.{.{ .integer = written_id }},
            &updated_rows,
            QueryRows.collect,
        );
        const updated_at = if (updated_outcome == .ok and !updated_rows.failed and updated_rows.rows.items.len > 0)
            updated_rows.rows.items[0].updated_at
        else
            "";

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"id\":");
        try writer.print("{d}", .{written_id});
        try writer.writeAll(",\"updatedAt\":");
        try writeJsonString(&writer, updated_at);
        try writer.writeByte('}');
        return writer.buffered();
    }

    pub fn delete(self: *Store, payload: []const u8, output: []u8) ![]const u8 {
        const id = jsonI64(payload, "id") orelse return error.InvalidRequest;
        const outcome = self.db.exec(&.{
            .{
                .sql = "DELETE FROM entry_summary WHERE entry_id = ?1;",
                .params = &.{.{ .integer = id }},
            },
            .{
                .sql = "DELETE FROM entry_embedding WHERE entry_id = ?1;",
                .params = &.{.{ .integer = id }},
            },
            .{
                .sql = "DELETE FROM journal_entry WHERE id = ?1;",
                .params = &.{.{ .integer = id }},
            },
            .{
                .sql = "DELETE FROM semantic_fact WHERE source_type = ?1 AND source_id = ?2;",
                .params = &.{ .{ .text = DreamSource.entry.sqlName() }, .{ .integer = id } },
            },
            .{
                .sql = "DELETE FROM episodic_event WHERE source_type = ?1 AND source_id = ?2;",
                .params = &.{ .{ .text = DreamSource.entry.sqlName() }, .{ .integer = id } },
            },
            .{
                .sql = "DELETE FROM dream_state WHERE source_type = ?1 AND source_id = ?2;",
                .params = &.{ .{ .text = DreamSource.entry.sqlName() }, .{ .integer = id } },
            },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"ok\":true}");
        return writer.buffered();
    }

    /// Remove Chat transcripts and every memory before an off-mode build can
    /// resume a session that already recalled memory. Journal entries,
    /// embeddings, summaries, and journal Dream timestamps remain. Rebuild the file so
    /// deleted plaintext does not linger in free pages or the write-ahead log.
    pub fn disableMemoriesAndChats(self: *Store) !void {
        self.beginDataWipe(false, true);
        const outcome = self.db.exec(&.{
            .{ .sql = "DELETE FROM chat_event;", .params = &.{} },
            .{ .sql = "DELETE FROM chat_index_skip;", .params = &.{} },
            .{ .sql = "DELETE FROM chat_embedding;", .params = &.{} },
            .{ .sql = "DELETE FROM chat_summary;", .params = &.{} },
            .{ .sql = "DELETE FROM chat_conversation;", .params = &.{} },
            .{ .sql = "DELETE FROM semantic_fact;", .params = &.{} },
            .{ .sql = "DELETE FROM episodic_event;", .params = &.{} },
            .{ .sql = "DELETE FROM dream_state WHERE source_type = 'conversation';", .params = &.{} },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;
        try self.scrubStorage();
    }

    /// Mark every source as pending so memories are extracted after an
    /// enabled build returns. Existing journal indexes remain reusable because
    /// their own embedding and summary freshness checks are separate.
    pub fn refreshMemoryExtractions(self: *Store) !void {
        const outcome = self.db.exec(&.{.{
            .sql = "DELETE FROM dream_state;",
            .params = &.{},
        }});
        if (outcome != .ok) return error.SqliteWriteFailed;
    }

    pub fn dataCounts(self: *Store, output: []u8) ![]const u8 {
        var rows = DataCountRows{};
        const outcome = self.db.query(
            \\SELECT
            \\  (SELECT count(*) FROM journal_entry) AS entries,
            \\  (SELECT count(*) FROM chat_conversation) AS conversations,
            \\  (SELECT count(*) FROM entry_embedding) +
            \\    (SELECT count(*) FROM entry_summary) +
            \\    (SELECT count(*) FROM chat_embedding) +
            \\    (SELECT count(*) FROM chat_summary) AS embeddings,
            \\  (SELECT count(*) FROM semantic_fact WHERE hidden = 0) +
            \\    (SELECT count(*) FROM episodic_event WHERE hidden = 0) AS memories;
        ,
            &.{},
            &rows,
            DataCountRows.collect,
        );
        if (outcome != .ok or rows.failed or !rows.found) return error.SqliteQueryFailed;

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"entries\":");
        try writer.print("{d}", .{rows.entries});
        try writer.writeAll(",\"conversations\":");
        try writer.print("{d}", .{rows.conversations});
        try writer.writeAll(",\"embeddings\":");
        try writer.print("{d}", .{rows.embeddings});
        try writer.writeAll(",\"memories\":");
        try writer.print("{d}", .{rows.memories});
        try writer.writeByte('}');
        return writer.buffered();
    }

    /// Whether the person has written or imported an entry, edited a sample
    /// entry, or started a chat. First-launch setup uses it to keep people who
    /// already use Sage out of setup.
    ///
    /// Migration 1 puts three sample entries in every new journal, so a plain
    /// row count could never be zero. Those rows keep the epoch `updated_at`
    /// that migration 4 gave them until the person edits one: saving and
    /// importing stamp the real time, and the encryption rewrite leaves it
    /// alone. Deleting a sample entry leaves no row to count either way.
    pub fn hasUserContent(self: *Store) !bool {
        const found = try self.countDataRows(
            \\SELECT EXISTS(SELECT 1 FROM journal_entry WHERE updated_at <> '1970-01-01T00:00:00.000Z')
            \\  OR EXISTS(SELECT 1 FROM chat_conversation) AS n;
            ,
        );
        return found != 0;
    }

    fn countDataRows(self: *Store, sql: []const u8) !i64 {
        var rows = CountRows{};
        const outcome = self.db.query(sql, &.{}, &rows, CountRows.collect);
        if (outcome != .ok or rows.failed or !rows.found) return error.SqliteQueryFailed;
        return rows.value;
    }

    pub fn deleteEntries(self: *Store, output: []u8) ![]const u8 {
        self.beginDataWipe(true, false);
        const outcome = self.db.exec(&.{
            .{ .sql = "DELETE FROM entry_summary;", .params = &.{} },
            .{ .sql = "DELETE FROM entry_embedding;", .params = &.{} },
            .{ .sql = "DELETE FROM journal_entry;", .params = &.{} },
            .{ .sql = "DELETE FROM semantic_fact WHERE source_type = 'entry';", .params = &.{} },
            .{ .sql = "DELETE FROM episodic_event WHERE source_type = 'entry';", .params = &.{} },
            .{ .sql = "DELETE FROM dream_state WHERE source_type = 'entry';", .params = &.{} },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;
        return self.dataWipeResult(output);
    }

    pub fn deleteConversations(self: *Store, output: []u8) ![]const u8 {
        self.beginDataWipe(false, true);
        const outcome = self.db.exec(&.{
            .{ .sql = "DELETE FROM chat_event;", .params = &.{} },
            .{ .sql = "DELETE FROM chat_index_skip;", .params = &.{} },
            .{ .sql = "DELETE FROM chat_embedding;", .params = &.{} },
            .{ .sql = "DELETE FROM chat_summary;", .params = &.{} },
            .{ .sql = "DELETE FROM chat_conversation;", .params = &.{} },
            .{ .sql = "DELETE FROM semantic_fact WHERE source_type = 'conversation';", .params = &.{} },
            .{ .sql = "DELETE FROM episodic_event WHERE source_type = 'conversation';", .params = &.{} },
            .{ .sql = "DELETE FROM dream_state WHERE source_type = 'conversation';", .params = &.{} },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;
        return self.dataWipeResult(output);
    }

    pub fn deleteEmbeddings(self: *Store, output: []u8) ![]const u8 {
        self.beginDataWipe(false, false);
        const outcome = self.db.exec(&.{
            .{ .sql = "DELETE FROM entry_embedding;", .params = &.{} },
            .{ .sql = "DELETE FROM entry_summary;", .params = &.{} },
            .{ .sql = "DELETE FROM chat_embedding;", .params = &.{} },
            .{ .sql = "DELETE FROM chat_summary;", .params = &.{} },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;
        return self.dataWipeResult(output);
    }

    pub fn deleteMemories(self: *Store, output: []u8) ![]const u8 {
        self.beginDataWipe(false, false);
        const outcome = self.db.exec(&.{
            .{ .sql = "DELETE FROM semantic_fact;", .params = &.{} },
            .{ .sql = "DELETE FROM episodic_event;", .params = &.{} },
            .{ .sql = "DELETE FROM dream_state;", .params = &.{} },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;
        return self.dataWipeResult(output);
    }

    fn dataWipeResult(self: *Store, output: []u8) ![]const u8 {
        self.scrubStorage() catch {};

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"ok\":true}");
        return writer.buffered();
    }

    /// Wipe journal entries, chats, embeddings, summaries, and dreamed
    /// memories. Lock and encryption rows in `app_setting` stay so the app
    /// does not reset. Extra Chat instructions in `agent_instruction` stay
    /// too. Rebuilds the file afterwards so deleted plaintext
    /// does not linger in free pages or the write-ahead log. A failed
    /// rebuild still reports ok; the rows are already gone.
    pub fn deleteAllData(self: *Store, output: []u8) ![]const u8 {
        self.beginDataWipe(true, true);
        const outcome = self.db.exec(&.{
            .{ .sql = "DELETE FROM chat_event;", .params = &.{} },
            .{ .sql = "DELETE FROM chat_index_skip;", .params = &.{} },
            .{ .sql = "DELETE FROM chat_embedding;", .params = &.{} },
            .{ .sql = "DELETE FROM chat_summary;", .params = &.{} },
            .{ .sql = "DELETE FROM chat_conversation;", .params = &.{} },
            .{ .sql = "DELETE FROM entry_summary;", .params = &.{} },
            .{ .sql = "DELETE FROM entry_embedding;", .params = &.{} },
            .{ .sql = "DELETE FROM journal_entry;", .params = &.{} },
            .{ .sql = "DELETE FROM semantic_fact;", .params = &.{} },
            .{ .sql = "DELETE FROM episodic_event;", .params = &.{} },
            .{ .sql = "DELETE FROM dream_state;", .params = &.{} },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;
        return self.dataWipeResult(output);
    }

    /// Read the shipped Chat prompt plus any extra instructions from Settings.
    pub fn agentInstructionsGet(self: *Store, output: []u8) ![]const u8 {
        const user = try self.loadAgentUserInstruction();
        defer self.allocator.free(user);
        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"builtin\":");
        try writeJsonStringStreaming(&writer, builtin_agent_instructions);
        try writer.writeAll(",\"user\":");
        try writeJsonStringStreaming(&writer, user);
        try writer.writeByte('}');
        return writer.buffered();
    }

    /// Write extra Chat instructions from Settings. Empty text deletes the row.
    pub fn agentInstructionsSave(self: *Store, payload: []const u8, output: []u8) ![]const u8 {
        var string_buf: [agent_user_instruction_max_bytes + 64]u8 = undefined;
        var used: usize = 0;
        const user = jsonString(payload, "user", &string_buf, &used) orelse return error.InvalidRequest;
        if (user.len > agent_user_instruction_max_bytes) return error.TooLarge;
        if (user.len == 0) {
            const outcome = self.db.exec(&.{.{
                .sql = "DELETE FROM agent_instruction WHERE key = ?1;",
                .params = &.{.{ .text = agent_user_instruction_key }},
            }});
            if (outcome != .ok) return error.SqliteWriteFailed;
        } else {
            const stored = try self.encryptForStorage(vault_mod.aad_agent_user, user);
            defer self.allocator.free(stored);
            const outcome = self.db.exec(&.{.{
                .sql = "INSERT INTO agent_instruction (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                .params = &.{ .{ .text = agent_user_instruction_key }, .{ .text = stored } },
            }});
            if (outcome != .ok) return error.SqliteWriteFailed;
        }
        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"ok\":true}");
        return writer.buffered();
    }

    /// Decrypted extra instructions for the Chat agent. Missing row is `""`.
    pub fn writeAgentUserInstructionsJson(self: *Store, writer: *std.Io.Writer) !void {
        const user = try self.loadAgentUserInstruction();
        defer self.allocator.free(user);
        try writer.writeAll("{\"user\":");
        try writeJsonStringStreaming(writer, user);
        try writer.writeByte('}');
    }

    fn loadAgentUserInstruction(self: *Store) ![]u8 {
        var rows = KvRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT key, value FROM agent_instruction WHERE key = ?1;",
            &.{.{ .text = agent_user_instruction_key }},
            &rows,
            KvRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        if (rows.rows.items.len == 0) return self.allocator.dupe(u8, "");
        return self.decryptFromStorage(vault_mod.aad_agent_user, rows.rows.items[0].value);
    }

    /// Load the raw body and format for a single entry, without chunking.
    /// Returns an owned slice (caller frees via the store's allocator).
    pub fn loadBody(self: *Store, id: i64) !struct { body: []u8, format: []u8 } {
        var rows = QueryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT body_format FROM journal_entry WHERE id = ?1;",
            &.{.{ .integer = id }},
            &rows,
            QueryRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        if (rows.rows.items.len == 0) return error.NotFound;
        const row = rows.rows.items[0];
        const stored_body = try self.loadStoredColumn("journal_entry", "body", id);
        defer self.allocator.free(stored_body);
        const body = try self.decryptFromStorage(vault_mod.aad_entry_body, stored_body);
        errdefer self.allocator.free(body);
        const format = try self.allocator.dupe(u8, if (row.format.len > 0) row.format else "plain");
        return .{ .body = body, .format = format };
    }

    /// Decrypted id/date/title for every entry, oldest id first. Caller frees
    /// with `freeExportMeta`. Bodies are loaded separately via `loadBody` so a
    /// query page never holds the whole column.
    pub const ExportMeta = struct {
        date: []u8,
        id: i64,
        title: []u8,
    };

    pub fn listExportMeta(self: *Store) ![]ExportMeta {
        var rows = QueryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT id, entry_date, title FROM journal_entry ORDER BY id ASC;",
            &.{},
            &rows,
            QueryRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;

        var collected: std.ArrayList(ExportMeta) = .empty;
        errdefer {
            for (collected.items) |item| {
                self.allocator.free(item.date);
                self.allocator.free(item.title);
            }
            collected.deinit(self.allocator);
        }

        for (rows.rows.items) |row| {
            const title = try self.decryptFromStorage(vault_mod.aad_entry_title, row.title);
            errdefer self.allocator.free(title);
            const date = try self.allocator.dupe(u8, row.date);
            errdefer self.allocator.free(date);
            try collected.append(self.allocator, .{ .date = date, .id = row.id, .title = title });
        }
        return collected.toOwnedSlice(self.allocator);
    }

    pub fn freeExportMeta(self: *Store, items: []ExportMeta) void {
        for (items) |item| {
            self.allocator.free(item.date);
            self.allocator.free(item.title);
        }
        self.allocator.free(items);
    }

    /// Replace all embeddings for an entry. The delete and every insert run in
    /// one `exec` call, which the store wraps in a single transaction — the
    /// entry keeps its old embeddings unless all new ones commit.
    /// `vectors[i]` must be `f32` slices; they are serialized as little-endian
    /// bytes into BLOBs.
    pub fn replaceEmbeddings(
        self: *Store,
        entry_id: i64,
        chunks: []const []const u8,
        vectors: []const []const f32,
        model_name: []const u8,
    ) !void {
        if (chunks.len != vectors.len) return error.EmbeddingCountMismatch;
        const relational = native_sdk.relational_store;
        // One DELETE plus one INSERT per chunk, capped by the store's per-call
        // statement limit (64 chunks ≈ 500 KB of entry text).
        if (chunks.len + 1 > relational.max_exec_statements) return error.TooManyChunks;

        // Statements, params, and blobs must all outlive the exec call; an
        // arena frees them together afterwards.
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();

        const statements = try a.alloc(relational.Statement, chunks.len + 1);
        const delete_params = try a.alloc(relational.Value, 1);
        delete_params[0] = .{ .integer = entry_id };
        statements[0] = .{
            .sql = "DELETE FROM entry_embedding WHERE entry_id = ?1;",
            .params = delete_params,
        };

        for (chunks, vectors, 0..) |chunk_text, vec, index| {
            const blob = try a.alloc(u8, vec.len * @sizeOf(f32));
            for (vec, 0..) |val, vi| {
                const bits: u32 = @bitCast(val);
                std.mem.writeInt(u32, blob[vi * 4 ..][0..4], bits, .little);
            }
            const stored_text = if (self.vault) |v|
                try v.encryptField(a, vault_mod.aad_chunk_text, chunk_text)
            else
                chunk_text;
            const params = try a.alloc(relational.Value, 5);
            params[0] = .{ .integer = entry_id };
            params[1] = .{ .integer = @as(i64, @intCast(index)) };
            params[2] = .{ .text = stored_text };
            params[3] = .{ .blob = blob };
            params[4] = .{ .text = model_name };
            statements[index + 1] = .{
                .sql = "INSERT INTO entry_embedding (entry_id, chunk_index, chunk_text, embedding, model) VALUES (?1, ?2, ?3, ?4, ?5);",
                .params = params,
            };
        }

        const outcome = self.db.exec(statements);
        if (outcome != .ok) return error.SqliteWriteFailed;
    }

    /// Replace the summary row for an entry. The delete and insert run in
    /// one `exec` call, which the store wraps in a single transaction.
    /// `vector` is serialized as little-endian f32 bytes into a BLOB.
    pub fn replaceSummary(
        self: *Store,
        entry_id: i64,
        summary: []const u8,
        vector: []const f32,
        model_name: []const u8,
        embed_model: []const u8,
    ) !void {
        if (vector.len == 0) return error.InvalidEmbedding;
        const relational = native_sdk.relational_store;

        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();

        const blob = try a.alloc(u8, vector.len * @sizeOf(f32));
        for (vector, 0..) |val, vi| {
            const bits: u32 = @bitCast(val);
            std.mem.writeInt(u32, blob[vi * 4 ..][0..4], bits, .little);
        }
        const stored_summary = if (self.vault) |v|
            try v.encryptField(a, vault_mod.aad_entry_summary, summary)
        else
            summary;

        const delete_params = try a.alloc(relational.Value, 1);
        delete_params[0] = .{ .integer = entry_id };
        const insert_params = try a.alloc(relational.Value, 5);
        insert_params[0] = .{ .integer = entry_id };
        insert_params[1] = .{ .text = stored_summary };
        insert_params[2] = .{ .blob = blob };
        insert_params[3] = .{ .text = model_name };
        insert_params[4] = .{ .text = embed_model };

        const outcome = self.db.exec(&.{
            .{
                .sql = "DELETE FROM entry_summary WHERE entry_id = ?1;",
                .params = delete_params,
            },
            .{
                .sql = "INSERT INTO entry_summary (entry_id, summary, embedding, model, embed_model) VALUES (?1, ?2, ?3, ?4, ?5);",
                .params = insert_params,
            },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;
    }

    pub fn replaceChatEmbeddings(
        self: *Store,
        conversation_id: i64,
        chunks: []const []const u8,
        vectors: []const []const f32,
        model_name: []const u8,
    ) !void {
        if (chunks.len != vectors.len) return error.EmbeddingCountMismatch;
        const relational = native_sdk.relational_store;
        if (chunks.len + 1 > relational.max_exec_statements) return error.TooManyChunks;

        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();

        const statements = try a.alloc(relational.Statement, chunks.len + 1);
        const delete_params = try a.alloc(relational.Value, 1);
        delete_params[0] = .{ .integer = conversation_id };
        statements[0] = .{
            .sql = "DELETE FROM chat_embedding WHERE conversation_id = ?1;",
            .params = delete_params,
        };

        for (chunks, vectors, 0..) |chunk_text, vec, index| {
            const blob = try encodeVector(a, vec);
            var aad_buf: [80]u8 = undefined;
            const aad = vault_mod.aadChatChunk(&aad_buf, conversation_id, @intCast(index));
            const stored_text = if (self.vault) |v|
                try v.encryptField(a, aad, chunk_text)
            else
                chunk_text;
            const params = try a.alloc(relational.Value, 5);
            params[0] = .{ .integer = conversation_id };
            params[1] = .{ .integer = @as(i64, @intCast(index)) };
            params[2] = .{ .text = stored_text };
            params[3] = .{ .blob = blob };
            params[4] = .{ .text = model_name };
            statements[index + 1] = .{
                .sql = "INSERT INTO chat_embedding (conversation_id, chunk_index, chunk_text, embedding, model) VALUES (?1, ?2, ?3, ?4, ?5);",
                .params = params,
            };
        }

        const outcome = self.db.exec(statements);
        if (outcome != .ok) return error.SqliteWriteFailed;
    }

    pub fn replaceChatSummary(
        self: *Store,
        conversation_id: i64,
        summary: []const u8,
        vector: []const f32,
        model_name: []const u8,
        embed_model: []const u8,
    ) !void {
        if (vector.len == 0) return error.InvalidEmbedding;
        const relational = native_sdk.relational_store;

        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();

        const blob = try encodeVector(a, vector);
        var aad_buf: [80]u8 = undefined;
        const aad = vault_mod.aadChatSummary(&aad_buf, conversation_id);
        const stored_summary = if (self.vault) |v|
            try v.encryptField(a, aad, summary)
        else
            summary;

        const delete_params = try a.alloc(relational.Value, 1);
        delete_params[0] = .{ .integer = conversation_id };
        const insert_params = try a.alloc(relational.Value, 5);
        insert_params[0] = .{ .integer = conversation_id };
        insert_params[1] = .{ .text = stored_summary };
        insert_params[2] = .{ .blob = blob };
        insert_params[3] = .{ .text = model_name };
        insert_params[4] = .{ .text = embed_model };

        const outcome = self.db.exec(&.{
            .{
                .sql = "DELETE FROM chat_summary WHERE conversation_id = ?1;",
                .params = delete_params,
            },
            .{
                .sql = "INSERT INTO chat_summary (conversation_id, summary, embedding, model, embed_model) VALUES (?1, ?2, ?3, ?4, ?5);",
                .params = insert_params,
            },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;
    }

    /// Replace this source's unpinned facts and events and mark it dreamed,
    /// in one transaction. Pinned and hidden rows stay. Profile facts whose
    /// trimmed text already exists (ignoring case) on another source, or
    /// earlier in this batch, are skipped. Extracted facts and events whose
    /// text matches a remaining pinned or hidden row for this source
    /// (current wording or origin_text) are skipped too. A missing source
    /// inserts nothing, so an in-flight Dream cannot recreate memories
    /// after the journal entry or chat is deleted.
    pub fn commitDreamMemory(
        self: *Store,
        source: DreamSource,
        source_id: i64,
        facts: []const NewFact,
        events: []const NewEvent,
        model_name: []const u8,
    ) !struct { facts: usize, events: usize } {
        if (!try self.sourceExists(source, source_id)) {
            return .{ .facts = 0, .events = 0 };
        }
        for (facts) |item| {
            if (std.mem.eql(u8, item.kind, "fact") and (item.embedding == null or item.embedding.?.len == 0))
                return error.InvalidEmbedding;
        }
        for (events) |item| {
            if (item.embedding.len == 0) return error.InvalidEmbedding;
        }

        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();

        const existing_profile = try self.profileTextsExcluding(a, source, source_id);
        const skip_profile = try self.pinnedSemanticSkipTexts(a, source, source_id, "profile");
        const skip_facts = try self.pinnedSemanticSkipTexts(a, source, source_id, "fact");
        const skip_events = try self.pinnedEventSkipTexts(a, source, source_id);

        var kept_facts = std.ArrayList(NewFact).empty;
        for (facts) |item| {
            if (std.mem.eql(u8, item.kind, "profile") and
                (profileTextSeen(existing_profile, kept_facts.items, item.fact) or
                    memoryTextSeen(skip_profile, item.fact)))
            {
                continue;
            }
            if (std.mem.eql(u8, item.kind, "fact") and memoryTextSeen(skip_facts, item.fact)) {
                continue;
            }
            try kept_facts.append(a, item);
        }
        var kept_events = std.ArrayList(NewEvent).empty;
        for (events) |item| {
            if (memoryTextSeen(skip_events, item.event)) continue;
            try kept_events.append(a, item);
        }

        const relational = native_sdk.relational_store;
        const statement_count = 3 + kept_facts.items.len + kept_events.items.len;
        if (statement_count > relational.max_exec_statements) return error.TooManyChunks;

        const statements = try a.alloc(relational.Statement, statement_count);
        const source_name = source.sqlName();

        const delete_fact_params = try a.alloc(relational.Value, 2);
        delete_fact_params[0] = .{ .text = source_name };
        delete_fact_params[1] = .{ .integer = source_id };
        statements[0] = .{
            .sql = "DELETE FROM semantic_fact WHERE source_type = ?1 AND source_id = ?2 AND pinned = 0;",
            .params = delete_fact_params,
        };
        const delete_event_params = try a.alloc(relational.Value, 2);
        delete_event_params[0] = .{ .text = source_name };
        delete_event_params[1] = .{ .integer = source_id };
        statements[1] = .{
            .sql = "DELETE FROM episodic_event WHERE source_type = ?1 AND source_id = ?2 AND pinned = 0;",
            .params = delete_event_params,
        };

        var next_fact_id = try self.maxTableId("semantic_fact") + 1;
        var next_event_id = try self.maxTableId("episodic_event") + 1;
        var at: usize = 2;
        for (kept_facts.items) |item| {
            var subject_aad: [80]u8 = undefined;
            var fact_aad: [80]u8 = undefined;
            const stored_subject = if (self.vault) |v|
                try v.encryptField(a, vault_mod.aadSemanticSubject(&subject_aad, next_fact_id), item.subject)
            else
                item.subject;
            const stored_fact = if (self.vault) |v|
                try v.encryptField(a, vault_mod.aadSemanticFact(&fact_aad, next_fact_id), item.fact)
            else
                item.fact;
            const params = try a.alloc(relational.Value, 8);
            params[0] = .{ .integer = next_fact_id };
            params[1] = .{ .text = item.kind };
            params[2] = .{ .text = stored_subject };
            params[3] = .{ .text = stored_fact };
            params[4] = if (item.embedding) |vec|
                .{ .blob = try encodeVector(a, vec) }
            else
                .null_value;
            params[5] = .{ .text = source_name };
            params[6] = .{ .integer = source_id };
            params[7] = .{ .text = model_name };
            statements[at] = .{
                .sql = "INSERT INTO semantic_fact (id, kind, subject, fact, embedding, source_type, source_id, model, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, strftime('%Y-%m-%dT%H:%M:%fZ','now'));",
                .params = params,
            };
            at += 1;
            next_fact_id += 1;
        }
        for (kept_events.items) |item| {
            var aad_buf: [80]u8 = undefined;
            const stored_event = if (self.vault) |v|
                try v.encryptField(a, vault_mod.aadEpisodicEvent(&aad_buf, next_event_id), item.event)
            else
                item.event;
            const params = try a.alloc(relational.Value, 7);
            params[0] = .{ .integer = next_event_id };
            params[1] = .{ .text = stored_event };
            params[2] = .{ .text = item.occurred_at };
            params[3] = .{ .blob = try encodeVector(a, item.embedding) };
            params[4] = .{ .text = source_name };
            params[5] = .{ .integer = source_id };
            params[6] = .{ .text = model_name };
            statements[at] = .{
                .sql = "INSERT INTO episodic_event (id, event, occurred_at, embedding, source_type, source_id, model, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%Y-%m-%dT%H:%M:%fZ','now'));",
                .params = params,
            };
            at += 1;
            next_event_id += 1;
        }

        const mark_params = try a.alloc(relational.Value, 2);
        mark_params[0] = .{ .text = source_name };
        mark_params[1] = .{ .integer = source_id };
        statements[at] = .{
            .sql = "INSERT INTO dream_state (source_type, source_id, dreamed_at) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(source_type, source_id) DO UPDATE SET dreamed_at = excluded.dreamed_at;",
            .params = mark_params,
        };

        const outcome = self.db.exec(statements);
        if (outcome != .ok) return error.SqliteWriteFailed;
        return .{ .facts = kept_facts.items.len, .events = kept_events.items.len };
    }

    fn profileTextsExcluding(
        self: *Store,
        allocator: std.mem.Allocator,
        source: DreamSource,
        source_id: i64,
    ) ![][]const u8 {
        var texts = std.ArrayList([]const u8).empty;
        var last_id: i64 = 0;
        var page_size: i64 = 32;
        while (true) {
            var rows = MemoryRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                \\SELECT id, fact FROM semantic_fact
                \\WHERE kind = 'profile' AND id > ?1
                \\  AND NOT (source_type = ?2 AND source_id = ?3)
                \\ORDER BY id
                \\LIMIT ?4;
            ,
                &.{
                    .{ .integer = last_id },
                    .{ .text = source.sqlName() },
                    .{ .integer = source_id },
                    .{ .integer = page_size },
                },
                &rows,
                MemoryRows.collect,
            );
            if (outcome == .rejected and page_size > 1) {
                page_size = @max(1, @divTrunc(page_size, 2));
                continue;
            }
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_id = row.id;
                var fact_aad: [80]u8 = undefined;
                const fact = try self.decryptFromStorage(vault_mod.aadSemanticFact(&fact_aad, row.id), row.fact);
                defer self.allocator.free(fact);
                try texts.append(allocator, try allocator.dupe(u8, fact));
            }
        }
        return texts.toOwnedSlice(allocator);
    }

    fn pinnedSemanticSkipTexts(
        self: *Store,
        allocator: std.mem.Allocator,
        source: DreamSource,
        source_id: i64,
        kind: []const u8,
    ) ![][]const u8 {
        var texts = std.ArrayList([]const u8).empty;
        var last_id: i64 = 0;
        var page_size: i64 = 32;
        while (true) {
            var rows = MemoryRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                \\SELECT id, fact, origin_text FROM semantic_fact
                \\WHERE kind = ?1 AND source_type = ?2 AND source_id = ?3
                \\  AND pinned = 1 AND id > ?4
                \\ORDER BY id
                \\LIMIT ?5;
            ,
                &.{
                    .{ .text = kind },
                    .{ .text = source.sqlName() },
                    .{ .integer = source_id },
                    .{ .integer = last_id },
                    .{ .integer = page_size },
                },
                &rows,
                MemoryRows.collect,
            );
            if (outcome == .rejected and page_size > 1) {
                page_size = @max(1, @divTrunc(page_size, 2));
                continue;
            }
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_id = row.id;
                try appendSkipText(self, allocator, &texts, vault_mod.aadSemanticFact, row.id, row.fact);
                if (row.origin_text.len > 0) {
                    try appendSkipText(self, allocator, &texts, vault_mod.aadSemanticOrigin, row.id, row.origin_text);
                }
            }
        }
        return texts.toOwnedSlice(allocator);
    }

    fn pinnedEventSkipTexts(
        self: *Store,
        allocator: std.mem.Allocator,
        source: DreamSource,
        source_id: i64,
    ) ![][]const u8 {
        var texts = std.ArrayList([]const u8).empty;
        var last_id: i64 = 0;
        var page_size: i64 = 32;
        while (true) {
            var rows = MemoryRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                \\SELECT id, event AS fact, origin_text FROM episodic_event
                \\WHERE source_type = ?1 AND source_id = ?2 AND pinned = 1 AND id > ?3
                \\ORDER BY id
                \\LIMIT ?4;
            ,
                &.{
                    .{ .text = source.sqlName() },
                    .{ .integer = source_id },
                    .{ .integer = last_id },
                    .{ .integer = page_size },
                },
                &rows,
                MemoryRows.collect,
            );
            if (outcome == .rejected and page_size > 1) {
                page_size = @max(1, @divTrunc(page_size, 2));
                continue;
            }
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_id = row.id;
                try appendSkipText(self, allocator, &texts, vault_mod.aadEpisodicEvent, row.id, row.fact);
                if (row.origin_text.len > 0) {
                    try appendSkipText(self, allocator, &texts, vault_mod.aadEpisodicOrigin, row.id, row.origin_text);
                }
            }
        }
        return texts.toOwnedSlice(allocator);
    }

    fn appendSkipText(
        self: *Store,
        allocator: std.mem.Allocator,
        texts: *std.ArrayList([]const u8),
        comptime aadFn: fn ([]u8, i64) []u8,
        id: i64,
        stored: []const u8,
    ) !void {
        var aad_buf: [80]u8 = undefined;
        const text = try self.decryptFromStorage(aadFn(&aad_buf, id), stored);
        defer self.allocator.free(text);
        try texts.append(allocator, try allocator.dupe(u8, text));
    }

    pub fn sourceExists(self: *Store, source: DreamSource, source_id: i64) !bool {
        const sql = switch (source) {
            .entry => "SELECT id AS n FROM journal_entry WHERE id = ?1;",
            .conversation => "SELECT id AS n FROM chat_conversation WHERE id = ?1;",
        };
        return self.idMatches(sql, source_id);
    }

    pub fn markDreamed(self: *Store, source: DreamSource, source_id: i64) !void {
        const outcome = self.db.exec(&.{.{
            .sql = "INSERT INTO dream_state (source_type, source_id, dreamed_at) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(source_type, source_id) DO UPDATE SET dreamed_at = excluded.dreamed_at;",
            .params = &.{ .{ .text = source.sqlName() }, .{ .integer = source_id } },
        }});
        if (outcome != .ok) return error.SqliteWriteFailed;
    }

    /// Newest `dreamed_at` across every source, or null when nothing has
    /// been dreamed. Caller frees a non-null slice via the store allocator.
    pub fn lastDreamedAt(self: *Store) !?[]u8 {
        var rows = QueryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT MAX(dreamed_at) AS entry_date FROM dream_state;",
            &.{},
            &rows,
            QueryRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        if (rows.rows.items.len == 0) return null;
        const date = rows.rows.items[0].date;
        if (date.len == 0) return null;
        return try self.allocator.dupe(u8, date);
    }

    pub fn entryDate(self: *Store, id: i64) ![]u8 {
        var rows = QueryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT id, entry_date FROM journal_entry WHERE id = ?1;",
            &.{.{ .integer = id }},
            &rows,
            QueryRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        if (rows.rows.items.len == 0) return error.NotFound;
        return try self.allocator.dupe(u8, rows.rows.items[0].date);
    }

    /// Decrypt chat events and keep user/assistant text. Caller frees
    /// `date`, `text`, and `recent` via the store allocator.
    pub fn loadConversationText(self: *Store, id: i64) !ConversationText {
        var meta = ChatRows.init(self.allocator);
        defer meta.deinit();
        const meta_outcome = self.db.query(
            "SELECT id, created_at, title_locked FROM chat_conversation WHERE id = ?1;",
            &.{.{ .integer = id }},
            &meta,
            ChatRows.collect,
        );
        if (meta_outcome != .ok) return error.SqliteQueryFailed;
        if (meta.failed) return error.SqlitePageFailed;
        if (meta.rows.items.len == 0) return error.NotFound;
        const created = meta.rows.items[0].created_at;
        const title_locked = meta.rows.items[0].title_locked != 0;
        const date = try self.allocator.dupe(u8, if (created.len >= 10) created[0..10] else created);
        errdefer self.allocator.free(date);

        var out = std.ArrayList(u8).empty;
        errdefer out.deinit(self.allocator);
        var recent_ring = RecentMessages.init(self.allocator);
        defer recent_ring.deinit();

        var last_seq: i64 = -1;
        while (true) {
            var event_rows = ChatEventRows.init(self.allocator);
            defer event_rows.deinit();
            const outcome = self.db.query(
                "SELECT seq, event FROM chat_event WHERE conversation_id = ?1 AND seq > ?2 ORDER BY seq LIMIT 32;",
                &.{ .{ .integer = id }, .{ .integer = last_seq } },
                &event_rows,
                ChatEventRows.collect,
            );
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (event_rows.failed) return error.SqlitePageFailed;
            if (event_rows.rows.items.len == 0) break;
            for (event_rows.rows.items) |event_row| {
                last_seq = event_row.seq;
                var aad_buf: [80]u8 = undefined;
                const aad = chatEventAad(&aad_buf, id, event_row.seq);
                const plaintext = try self.decryptFromStorage(aad, event_row.event);
                defer self.allocator.free(plaintext);
                try appendTranscriptEvent(&out, &recent_ring, self.allocator, plaintext);
            }
        }

        const recent = try recent_ring.format();
        errdefer self.allocator.free(recent);
        return .{
            .date = date,
            .recent = recent,
            .text = try out.toOwnedSlice(self.allocator),
            .title_locked = title_locked,
        };
    }

    pub fn listProfile(self: *Store, limit: i64, writer: *std.Io.Writer) !void {
        const take: i64 = @max(@min(limit, profile_recall_limit), 1);
        var rows = MemoryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT id, subject, fact, source_type, source_id FROM semantic_fact WHERE kind = 'profile' AND hidden = 0 ORDER BY id DESC LIMIT ?1;",
            &.{.{ .integer = take }},
            &rows,
            MemoryRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;

        try writer.writeAll("{\"facts\":[");
        for (rows.rows.items, 0..) |row, index| {
            if (index > 0) try writer.writeAll(",");
            var subject_aad: [80]u8 = undefined;
            var fact_aad: [80]u8 = undefined;
            const subject = try self.decryptFromStorage(vault_mod.aadSemanticSubject(&subject_aad, row.id), row.subject);
            defer self.allocator.free(subject);
            const fact = try self.decryptFromStorage(vault_mod.aadSemanticFact(&fact_aad, row.id), row.fact);
            defer self.allocator.free(fact);
            try writer.writeAll("{\"id\":");
            try writer.print("{d}", .{row.id});
            try writer.writeAll(",\"subject\":");
            try writeJsonStringStreaming(writer, subject);
            try writer.writeAll(",\"fact\":");
            try writeJsonStringStreaming(writer, fact);
            try writeMemorySource(writer, row.source_type, row.source_id);
            try writer.writeByte('}');
        }
        try writer.writeAll("]}");
    }

    pub fn semanticSearchFacts(self: *Store, query_vector: []const f32, limit: i64, writer: *std.Io.Writer) !void {
        const take: usize = @intCast(@max(@min(limit, 25), 1));
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();

        var hits = std.ArrayList(MemoryHit).empty;
        var last_id: i64 = 0;
        var page_size: i64 = 32;
        while (true) {
            var rows = MemoryRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                \\SELECT id, subject, fact, embedding, source_type, source_id
                \\FROM semantic_fact
                \\WHERE kind = 'fact' AND hidden = 0 AND id > ?1
                \\ORDER BY id
                \\LIMIT ?2;
            ,
                &.{ .{ .integer = last_id }, .{ .integer = page_size } },
                &rows,
                MemoryRows.collect,
            );
            if (outcome == .rejected and page_size > 1) {
                page_size = @max(1, @divTrunc(page_size, 2));
                continue;
            }
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_id = row.id;
                if (row.embedding.len == 0) continue;
                const vec = decodeVectorAlloc(a, row.embedding) catch |err| switch (err) {
                    error.InvalidEmbedding => continue,
                    else => |e| return e,
                };
                if (vec.len != query_vector.len) continue;
                const score = cosineSimilarity(query_vector, vec);
                var subject_aad: [80]u8 = undefined;
                var fact_aad: [80]u8 = undefined;
                const subject = try self.decryptFromStorage(vault_mod.aadSemanticSubject(&subject_aad, row.id), row.subject);
                defer self.allocator.free(subject);
                const fact = try self.decryptFromStorage(vault_mod.aadSemanticFact(&fact_aad, row.id), row.fact);
                defer self.allocator.free(fact);
                try hits.append(a, .{
                    .date = "",
                    .id = row.id,
                    .score = score,
                    .source_id = row.source_id,
                    .source_type = try a.dupe(u8, row.source_type),
                    .subject = try a.dupe(u8, subject),
                    .text = try a.dupe(u8, fact),
                });
            }
        }

        std.mem.sort(MemoryHit, hits.items, {}, MemoryHit.higherScore);
        try writer.writeAll("{\"results\":[");
        const count = @min(hits.items.len, take);
        for (hits.items[0..count], 0..) |hit, index| {
            if (index > 0) try writer.writeAll(",");
            try writer.writeAll("{\"id\":");
            try writer.print("{d}", .{hit.id});
            try writer.writeAll(",\"subject\":");
            try writeJsonStringStreaming(writer, hit.subject);
            try writer.writeAll(",\"fact\":");
            try writeJsonStringStreaming(writer, hit.text);
            try writer.writeAll(",\"score\":");
            try writer.print("{d:.4}", .{hit.score});
            try writeMemorySource(writer, hit.source_type, hit.source_id);
            try writer.writeByte('}');
        }
        try writer.writeAll("]}");
    }

    pub fn semanticSearchEvents(self: *Store, query_vector: []const f32, limit: i64, writer: *std.Io.Writer) !void {
        const take: usize = @intCast(@max(@min(limit, 25), 1));
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();

        var hits = std.ArrayList(MemoryHit).empty;
        var last_id: i64 = 0;
        var page_size: i64 = 32;
        while (true) {
            var rows = MemoryRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                \\SELECT id, event AS fact, occurred_at, embedding, source_type, source_id
                \\FROM episodic_event
                \\WHERE hidden = 0 AND id > ?1
                \\ORDER BY id
                \\LIMIT ?2;
            ,
                &.{ .{ .integer = last_id }, .{ .integer = page_size } },
                &rows,
                MemoryRows.collect,
            );
            if (outcome == .rejected and page_size > 1) {
                page_size = @max(1, @divTrunc(page_size, 2));
                continue;
            }
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_id = row.id;
                const vec = decodeVectorAlloc(a, row.embedding) catch |err| switch (err) {
                    error.InvalidEmbedding => continue,
                    else => |e| return e,
                };
                if (vec.len != query_vector.len) continue;
                const score = cosineSimilarity(query_vector, vec);
                var aad_buf: [80]u8 = undefined;
                const event_text = try self.decryptFromStorage(vault_mod.aadEpisodicEvent(&aad_buf, row.id), row.fact);
                defer self.allocator.free(event_text);
                try hits.append(a, .{
                    .date = try a.dupe(u8, row.occurred_at),
                    .id = row.id,
                    .score = score,
                    .source_id = row.source_id,
                    .source_type = try a.dupe(u8, row.source_type),
                    .subject = "",
                    .text = try a.dupe(u8, event_text),
                });
            }
        }

        std.mem.sort(MemoryHit, hits.items, {}, MemoryHit.higherScore);
        try writer.writeAll("{\"results\":[");
        const count = @min(hits.items.len, take);
        for (hits.items[0..count], 0..) |hit, index| {
            if (index > 0) try writer.writeAll(",");
            try writer.writeAll("{\"id\":");
            try writer.print("{d}", .{hit.id});
            try writer.writeAll(",\"event\":");
            try writeJsonStringStreaming(writer, hit.text);
            try writer.writeAll(",\"occurredAt\":");
            try writeJsonStringStreaming(writer, hit.date);
            try writer.writeAll(",\"score\":");
            try writer.print("{d:.4}", .{hit.score});
            try writeMemorySource(writer, hit.source_type, hit.source_id);
            try writer.writeByte('}');
        }
        try writer.writeAll("]}");
    }

    pub fn listMemories(self: *Store, output: []u8) ![]const u8 {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const profile = try self.collectSemanticList(a, "profile");
        const facts = try self.collectSemanticList(a, "fact");
        const events = try self.collectEventList(a);

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"profile\":[");
        try writeMemoryList(&writer, profile, .profile);
        try writer.writeAll("],\"facts\":[");
        try writeMemoryList(&writer, facts, .fact);
        try writer.writeAll("],\"events\":[");
        try writeMemoryList(&writer, events, .event);
        try writer.writeAll("]}");
        return writer.buffered();
    }

    pub fn memorySearch(self: *Store, payload: []const u8, output: []u8) ![]const u8 {
        var string_buf: [4096]u8 = undefined;
        var used: usize = 0;
        const query = jsonString(payload, "query", &string_buf, &used) orelse return error.InvalidRequest;
        if (query.len == 0) {
            var empty = std.Io.Writer.fixed(output);
            try empty.writeAll("{\"hits\":[]}");
            return empty.buffered();
        }

        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();

        var matches: std.ArrayList(MemorySearchMatch) = .empty;
        try appendMemorySearchHits(a, &matches, try self.collectSemanticList(a, "profile"), .profile, query);
        try appendMemorySearchHits(a, &matches, try self.collectSemanticList(a, "fact"), .fact, query);
        try appendMemorySearchHits(a, &matches, try self.collectEventList(a), .event, query);
        std.mem.sort(MemorySearchMatch, matches.items, {}, MemorySearchMatch.newerFirst);

        var writer = std.Io.Writer.fixed(output);
        try writer.writeAll("{\"hits\":[");
        for (matches.items[0..@min(matches.items.len, memory_search_max_hits)], 0..) |match, index| {
            if (index > 0) try writer.writeAll(",");
            try writeMemorySearchHit(&writer, match);
        }
        try writer.writeAll("]}");
        return writer.buffered();
    }

    pub fn saveMemory(self: *Store, input: MemorySaveInput) !i64 {
        const fact = std.mem.trim(u8, input.fact, " \t\r\n");
        const event = std.mem.trim(u8, input.event, " \t\r\n");
        const subject = std.mem.trim(u8, input.subject, " \t\r\n");
        const occurred_at = std.mem.trim(u8, input.occurred_at, " \t\r\n");
        switch (input.kind) {
            .profile => {
                if (fact.len == 0) return error.InvalidRequest;
                if (input.embedding != null) return error.InvalidRequest;
            },
            .fact => {
                if (subject.len == 0 or fact.len == 0) return error.InvalidRequest;
                if (input.embedding == null or input.embedding.?.len == 0) return error.InvalidEmbedding;
            },
            .event => {
                if (event.len == 0) return error.InvalidRequest;
                if (input.embedding == null or input.embedding.?.len == 0) return error.InvalidEmbedding;
            },
        }

        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        return switch (input.kind) {
            .event => self.writeEventMemory(a, input, event, occurred_at),
            .fact => self.writeSemanticMemory(a, input, "fact", subject, fact),
            .profile => self.writeSemanticMemory(
                a,
                input,
                "profile",
                if (subject.len == 0) "user" else subject,
                fact,
            ),
        };
    }

    pub fn deleteMemory(self: *Store, kind: MemoryKind, id: i64) !void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        switch (kind) {
            .event => {
                const existing = try self.loadEventMemory(a, id) orelse return error.NotFound;
                if (std.mem.eql(u8, existing.source_type, user_memory_source)) {
                    const outcome = self.db.exec(&.{.{
                        .sql = "DELETE FROM episodic_event WHERE id = ?1;",
                        .params = &.{.{ .integer = id }},
                    }});
                    if (outcome != .ok) return error.SqliteWriteFailed;
                    return;
                }
                const origin = if (existing.origin_text.len > 0) existing.origin_text else existing.text;
                try self.hideEventMemory(a, existing.id, origin);
            },
            .fact, .profile => {
                const expected: []const u8 = if (kind == .profile) "profile" else "fact";
                const existing = try self.loadSemanticMemory(a, id) orelse return error.NotFound;
                if (!std.mem.eql(u8, existing.kind, expected)) return error.NotFound;
                if (std.mem.eql(u8, existing.source_type, user_memory_source)) {
                    const outcome = self.db.exec(&.{.{
                        .sql = "DELETE FROM semantic_fact WHERE id = ?1;",
                        .params = &.{.{ .integer = id }},
                    }});
                    if (outcome != .ok) return error.SqliteWriteFailed;
                    return;
                }
                const origin = if (existing.origin_text.len > 0) existing.origin_text else existing.fact;
                try self.hideSemanticMemory(a, existing.id, origin);
            },
        }
    }

    fn collectSemanticList(self: *Store, arena: std.mem.Allocator, kind: []const u8) ![]MemoryListItem {
        var items = std.ArrayList(MemoryListItem).empty;
        var last_id: i64 = 0;
        var page_size: i64 = 32;
        while (true) {
            var rows = MemoryRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                \\SELECT id, subject, fact, updated_at, pinned, source_type, source_id
                \\FROM semantic_fact
                \\WHERE kind = ?1 AND hidden = 0 AND id > ?2
                \\ORDER BY id
                \\LIMIT ?3;
            ,
                &.{ .{ .text = kind }, .{ .integer = last_id }, .{ .integer = page_size } },
                &rows,
                MemoryRows.collect,
            );
            if (outcome == .rejected and page_size > 1) {
                page_size = @max(1, @divTrunc(page_size, 2));
                continue;
            }
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_id = row.id;
                var subject_aad: [80]u8 = undefined;
                var fact_aad: [80]u8 = undefined;
                const subject = try self.decryptFromStorage(vault_mod.aadSemanticSubject(&subject_aad, row.id), row.subject);
                defer self.allocator.free(subject);
                const fact = try self.decryptFromStorage(vault_mod.aadSemanticFact(&fact_aad, row.id), row.fact);
                defer self.allocator.free(fact);
                try items.append(arena, .{
                    .id = row.id,
                    .pinned = row.pinned != 0,
                    .source_id = row.source_id,
                    .source_type = try arena.dupe(u8, row.source_type),
                    .subject = try arena.dupe(u8, subject),
                    .text = try arena.dupe(u8, fact),
                    .updated_at = try arena.dupe(u8, row.updated_at),
                });
            }
        }
        std.mem.sort(MemoryListItem, items.items, {}, MemoryListItem.newerFirst);
        return items.items;
    }

    fn collectEventList(self: *Store, arena: std.mem.Allocator) ![]MemoryListItem {
        var items = std.ArrayList(MemoryListItem).empty;
        var last_id: i64 = 0;
        var page_size: i64 = 32;
        while (true) {
            var rows = MemoryRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                \\SELECT episodic_event.id,
                \\       episodic_event.event AS fact,
                \\       episodic_event.occurred_at,
                \\       episodic_event.updated_at,
                \\       episodic_event.pinned,
                \\       episodic_event.source_type,
                \\       episodic_event.source_id,
                \\       CASE
                \\         WHEN episodic_event.source_type = 'entry' THEN journal_entry.title
                \\         WHEN episodic_event.source_type = 'conversation' THEN chat_conversation.title
                \\         ELSE ''
                \\       END AS source_title
                \\FROM episodic_event
                \\LEFT JOIN journal_entry
                \\  ON episodic_event.source_type = 'entry'
                \\ AND episodic_event.source_id = journal_entry.id
                \\LEFT JOIN chat_conversation
                \\  ON episodic_event.source_type = 'conversation'
                \\ AND episodic_event.source_id = chat_conversation.id
                \\WHERE episodic_event.hidden = 0 AND episodic_event.id > ?1
                \\ORDER BY episodic_event.id
                \\LIMIT ?2;
            ,
                &.{ .{ .integer = last_id }, .{ .integer = page_size } },
                &rows,
                MemoryRows.collect,
            );
            if (outcome == .rejected and page_size > 1) {
                page_size = @max(1, @divTrunc(page_size, 2));
                continue;
            }
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_id = row.id;
                var aad_buf: [80]u8 = undefined;
                const event_text = try self.decryptFromStorage(vault_mod.aadEpisodicEvent(&aad_buf, row.id), row.fact);
                defer self.allocator.free(event_text);
                const source_title = try self.decryptEventSourceTitle(row.source_type, row.source_title);
                defer self.allocator.free(source_title);
                try items.append(arena, .{
                    .id = row.id,
                    .occurred_at = try arena.dupe(u8, row.occurred_at),
                    .pinned = row.pinned != 0,
                    .source_id = row.source_id,
                    .source_title = try arena.dupe(u8, source_title),
                    .source_type = try arena.dupe(u8, row.source_type),
                    .text = try arena.dupe(u8, event_text),
                    .updated_at = try arena.dupe(u8, row.updated_at),
                });
            }
        }
        std.mem.sort(MemoryListItem, items.items, {}, MemoryListItem.laterEventFirst);
        return items.items;
    }

    fn writeSemanticMemory(
        self: *Store,
        arena: std.mem.Allocator,
        input: MemorySaveInput,
        kind: []const u8,
        subject: []const u8,
        fact: []const u8,
    ) !i64 {
        if (input.id) |id| {
            const existing = try self.loadSemanticMemory(arena, id) orelse return error.NotFound;
            if (!std.mem.eql(u8, existing.kind, kind)) return error.NotFound;
            const origin = if (existing.origin_text.len > 0) existing.origin_text else existing.fact;
            try self.updateSemanticMemory(arena, id, subject, fact, origin, input.embedding, input.model_name);
            return id;
        }
        const id = try self.maxTableId("semantic_fact") + 1;
        var subject_aad: [80]u8 = undefined;
        var fact_aad: [80]u8 = undefined;
        const stored_subject = if (self.vault) |v|
            try v.encryptField(arena, vault_mod.aadSemanticSubject(&subject_aad, id), subject)
        else
            subject;
        const stored_fact = if (self.vault) |v|
            try v.encryptField(arena, vault_mod.aadSemanticFact(&fact_aad, id), fact)
        else
            fact;
        const params = try arena.alloc(native_sdk.relational_store.Value, 8);
        params[0] = .{ .integer = id };
        params[1] = .{ .text = kind };
        params[2] = .{ .text = stored_subject };
        params[3] = .{ .text = stored_fact };
        params[4] = if (input.embedding) |vec|
            .{ .blob = try encodeVector(arena, vec) }
        else
            .null_value;
        params[5] = .{ .text = user_memory_source };
        params[6] = .{ .integer = 0 };
        params[7] = .{ .text = input.model_name };
        const outcome = self.db.exec(&.{.{
            .sql = "INSERT INTO semantic_fact (id, kind, subject, fact, embedding, source_type, source_id, model, pinned, hidden, origin_text, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, 0, '', strftime('%Y-%m-%dT%H:%M:%fZ','now'));",
            .params = params,
        }});
        if (outcome != .ok) return error.SqliteWriteFailed;
        return id;
    }

    fn writeEventMemory(
        self: *Store,
        arena: std.mem.Allocator,
        input: MemorySaveInput,
        event: []const u8,
        occurred_at: []const u8,
    ) !i64 {
        const embedding = input.embedding orelse return error.InvalidEmbedding;
        if (input.id) |id| {
            const existing = try self.loadEventMemory(arena, id) orelse return error.NotFound;
            const origin = if (existing.origin_text.len > 0) existing.origin_text else existing.text;
            try self.updateEventMemory(arena, id, event, occurred_at, origin, embedding, input.model_name);
            return id;
        }
        const id = try self.maxTableId("episodic_event") + 1;
        var aad_buf: [80]u8 = undefined;
        const stored_event = if (self.vault) |v|
            try v.encryptField(arena, vault_mod.aadEpisodicEvent(&aad_buf, id), event)
        else
            event;
        const params = try arena.alloc(native_sdk.relational_store.Value, 7);
        params[0] = .{ .integer = id };
        params[1] = .{ .text = stored_event };
        params[2] = .{ .text = occurred_at };
        params[3] = .{ .blob = try encodeVector(arena, embedding) };
        params[4] = .{ .text = user_memory_source };
        params[5] = .{ .integer = 0 };
        params[6] = .{ .text = input.model_name };
        const outcome = self.db.exec(&.{.{
            .sql = "INSERT INTO episodic_event (id, event, occurred_at, embedding, source_type, source_id, model, pinned, hidden, origin_text, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 0, '', strftime('%Y-%m-%dT%H:%M:%fZ','now'));",
            .params = params,
        }});
        if (outcome != .ok) return error.SqliteWriteFailed;
        return id;
    }

    fn updateSemanticMemory(
        self: *Store,
        arena: std.mem.Allocator,
        id: i64,
        subject: []const u8,
        fact: []const u8,
        origin: []const u8,
        embedding: ?[]const f32,
        model_name: []const u8,
    ) !void {
        var subject_aad: [80]u8 = undefined;
        var fact_aad: [80]u8 = undefined;
        var origin_aad: [80]u8 = undefined;
        const stored_subject = if (self.vault) |v|
            try v.encryptField(arena, vault_mod.aadSemanticSubject(&subject_aad, id), subject)
        else
            subject;
        const stored_fact = if (self.vault) |v|
            try v.encryptField(arena, vault_mod.aadSemanticFact(&fact_aad, id), fact)
        else
            fact;
        const stored_origin = try encryptOrigin(self, arena, vault_mod.aadSemanticOrigin(&origin_aad, id), origin);
        const outcome = if (embedding) |vec| blk: {
            const params = try arena.alloc(native_sdk.relational_store.Value, 6);
            params[0] = .{ .text = stored_subject };
            params[1] = .{ .text = stored_fact };
            params[2] = .{ .text = stored_origin };
            params[3] = .{ .blob = try encodeVector(arena, vec) };
            params[4] = .{ .text = model_name };
            params[5] = .{ .integer = id };
            break :blk self.db.exec(&.{.{
                .sql = "UPDATE semantic_fact SET subject = ?1, fact = ?2, origin_text = ?3, embedding = ?4, model = ?5, pinned = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?6;",
                .params = params,
            }});
        } else blk: {
            const params = try arena.alloc(native_sdk.relational_store.Value, 4);
            params[0] = .{ .text = stored_subject };
            params[1] = .{ .text = stored_fact };
            params[2] = .{ .text = stored_origin };
            params[3] = .{ .integer = id };
            break :blk self.db.exec(&.{.{
                .sql = "UPDATE semantic_fact SET subject = ?1, fact = ?2, origin_text = ?3, pinned = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?4;",
                .params = params,
            }});
        };
        if (outcome != .ok) return error.SqliteWriteFailed;
    }

    fn updateEventMemory(
        self: *Store,
        arena: std.mem.Allocator,
        id: i64,
        event: []const u8,
        occurred_at: []const u8,
        origin: []const u8,
        embedding: []const f32,
        model_name: []const u8,
    ) !void {
        var event_aad: [80]u8 = undefined;
        var origin_aad: [80]u8 = undefined;
        const stored_event = if (self.vault) |v|
            try v.encryptField(arena, vault_mod.aadEpisodicEvent(&event_aad, id), event)
        else
            event;
        const stored_origin = try encryptOrigin(self, arena, vault_mod.aadEpisodicOrigin(&origin_aad, id), origin);
        const params = try arena.alloc(native_sdk.relational_store.Value, 6);
        params[0] = .{ .text = stored_event };
        params[1] = .{ .text = occurred_at };
        params[2] = .{ .text = stored_origin };
        params[3] = .{ .blob = try encodeVector(arena, embedding) };
        params[4] = .{ .text = model_name };
        params[5] = .{ .integer = id };
        const outcome = self.db.exec(&.{.{
            .sql = "UPDATE episodic_event SET event = ?1, occurred_at = ?2, origin_text = ?3, embedding = ?4, model = ?5, pinned = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?6;",
            .params = params,
        }});
        if (outcome != .ok) return error.SqliteWriteFailed;
    }

    fn hideSemanticMemory(self: *Store, arena: std.mem.Allocator, id: i64, origin: []const u8) !void {
        var origin_aad: [80]u8 = undefined;
        const stored_origin = try encryptOrigin(self, arena, vault_mod.aadSemanticOrigin(&origin_aad, id), origin);
        const outcome = self.db.exec(&.{.{
            .sql = "UPDATE semantic_fact SET pinned = 1, hidden = 1, origin_text = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?2;",
            .params = &.{ .{ .text = stored_origin }, .{ .integer = id } },
        }});
        if (outcome != .ok) return error.SqliteWriteFailed;
    }

    fn hideEventMemory(self: *Store, arena: std.mem.Allocator, id: i64, origin: []const u8) !void {
        var origin_aad: [80]u8 = undefined;
        const stored_origin = try encryptOrigin(self, arena, vault_mod.aadEpisodicOrigin(&origin_aad, id), origin);
        const outcome = self.db.exec(&.{.{
            .sql = "UPDATE episodic_event SET pinned = 1, hidden = 1, origin_text = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?2;",
            .params = &.{ .{ .text = stored_origin }, .{ .integer = id } },
        }});
        if (outcome != .ok) return error.SqliteWriteFailed;
    }

    fn loadSemanticMemory(self: *Store, arena: std.mem.Allocator, id: i64) !?LoadedSemantic {
        var rows = MemoryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT id, kind, subject, fact, origin_text, source_type, source_id, pinned, hidden FROM semantic_fact WHERE id = ?1;",
            &.{.{ .integer = id }},
            &rows,
            MemoryRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        if (rows.rows.items.len == 0) return null;
        const row = rows.rows.items[0];
        var subject_aad: [80]u8 = undefined;
        var fact_aad: [80]u8 = undefined;
        var origin_aad: [80]u8 = undefined;
        const subject = try self.decryptFromStorage(vault_mod.aadSemanticSubject(&subject_aad, row.id), row.subject);
        defer self.allocator.free(subject);
        const fact = try self.decryptFromStorage(vault_mod.aadSemanticFact(&fact_aad, row.id), row.fact);
        defer self.allocator.free(fact);
        const origin = if (row.origin_text.len == 0)
            ""
        else blk: {
            const decrypted = try self.decryptFromStorage(vault_mod.aadSemanticOrigin(&origin_aad, row.id), row.origin_text);
            defer self.allocator.free(decrypted);
            break :blk try arena.dupe(u8, decrypted);
        };
        return .{
            .fact = try arena.dupe(u8, fact),
            .hidden = row.hidden,
            .id = row.id,
            .kind = try arena.dupe(u8, row.kind),
            .origin_text = origin,
            .pinned = row.pinned,
            .source_id = row.source_id,
            .source_type = try arena.dupe(u8, row.source_type),
            .subject = try arena.dupe(u8, subject),
        };
    }

    fn loadEventMemory(self: *Store, arena: std.mem.Allocator, id: i64) !?LoadedEvent {
        var rows = MemoryRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            "SELECT id, event AS fact, occurred_at, origin_text, source_type, source_id, pinned, hidden FROM episodic_event WHERE id = ?1;",
            &.{.{ .integer = id }},
            &rows,
            MemoryRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        if (rows.rows.items.len == 0) return null;
        const row = rows.rows.items[0];
        var event_aad: [80]u8 = undefined;
        var origin_aad: [80]u8 = undefined;
        const event_text = try self.decryptFromStorage(vault_mod.aadEpisodicEvent(&event_aad, row.id), row.fact);
        defer self.allocator.free(event_text);
        const origin = if (row.origin_text.len == 0)
            ""
        else blk: {
            const decrypted = try self.decryptFromStorage(vault_mod.aadEpisodicOrigin(&origin_aad, row.id), row.origin_text);
            defer self.allocator.free(decrypted);
            break :blk try arena.dupe(u8, decrypted);
        };
        return .{
            .hidden = row.hidden,
            .id = row.id,
            .occurred_at = try arena.dupe(u8, row.occurred_at),
            .origin_text = origin,
            .pinned = row.pinned,
            .source_id = row.source_id,
            .source_type = try arena.dupe(u8, row.source_type),
            .text = try arena.dupe(u8, event_text),
        };
    }

    fn encryptOrigin(self: *Store, arena: std.mem.Allocator, aad: []const u8, origin: []const u8) ![]const u8 {
        if (origin.len == 0) return "";
        if (self.vault) |v| return v.encryptField(arena, aad, origin);
        return origin;
    }

    fn maxTableId(self: *Store, comptime table: []const u8) !i64 {
        var counts = CountRows{};
        const outcome = self.db.query(
            "SELECT COALESCE(MAX(id), 0) AS n FROM " ++ table ++ ";",
            &.{},
            &counts,
            CountRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (counts.failed) return error.SqlitePageFailed;
        return counts.value;
    }

    fn insertEntry(
        self: *Store,
        date: []const u8,
        title: []const u8,
        body: []const u8,
        word_count: i64,
        format: []const u8,
    ) !i64 {
        const stored_title = try self.encryptForStorage(vault_mod.aad_entry_title, title);
        defer self.allocator.free(stored_title);
        const stored_body = try self.encryptForStorage(vault_mod.aad_entry_body, body);
        defer self.allocator.free(stored_body);
        const insert_outcome = self.db.exec(&.{
            .{
                .sql = "INSERT INTO journal_entry (entry_date, title, body, word_count, body_format, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ','now'));",
                .params = &.{
                    .{ .text = date },
                    .{ .text = stored_title },
                    .{ .text = stored_body },
                    .{ .integer = word_count },
                    .{ .text = format },
                },
            },
        });
        if (insert_outcome != .ok) return error.SqliteWriteFailed;

        var rows = QueryRows.init(self.allocator);
        defer rows.deinit();
        // RelationalStore.query uses a separate read connection on disk, so
        // last_insert_rowid() would be 0 after exec(). INTEGER PRIMARY KEY gives
        // the new row the current maximum id, which the reader sees after commit.
        const outcome = self.db.query(
            "SELECT MAX(id) AS id FROM journal_entry;",
            &.{},
            &rows,
            QueryRows.collect,
        );
        if (outcome != .ok or rows.failed or rows.rows.items.len == 0) return error.SqliteQueryFailed;
        return rows.rows.items[0].id;
    }

    fn updateEntry(
        self: *Store,
        id: i64,
        date: []const u8,
        title: []const u8,
        body: []const u8,
        word_count: i64,
        format: []const u8,
    ) !void {
        const stored_title = try self.encryptForStorage(vault_mod.aad_entry_title, title);
        defer self.allocator.free(stored_title);
        const stored_body = try self.encryptForStorage(vault_mod.aad_entry_body, body);
        defer self.allocator.free(stored_body);
        const outcome = self.db.exec(&.{
            .{
                .sql = "UPDATE journal_entry SET entry_date = ?1, title = ?2, body = ?3, word_count = ?4, body_format = ?5, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?6;",
                .params = &.{
                    .{ .text = date },
                    .{ .text = stored_title },
                    .{ .text = stored_body },
                    .{ .integer = word_count },
                    .{ .text = format },
                    .{ .integer = id },
                },
            },
        });
        if (outcome != .ok) return error.SqliteWriteFailed;
    }

    /// Return true if any non-empty protected field lacks the ciphertext
    /// prefix. The query mirrors the fields visited by `setRowsEncrypted`.
    pub fn hasPlaintextProtectedFields(self: *Store) !bool {
        const sql =
            \\SELECT 'found' AS key, 'true' AS value WHERE EXISTS (
            \\  SELECT 1 FROM journal_entry
            \\  WHERE (length(title) > 0 AND substr(title, 1, length(?1)) <> ?1)
            \\     OR (length(body) > 0 AND substr(body, 1, length(?1)) <> ?1)
            \\  UNION ALL
            \\  SELECT 1 FROM entry_embedding
            \\  WHERE length(chunk_text) > 0 AND substr(chunk_text, 1, length(?1)) <> ?1
            \\  UNION ALL
            \\  SELECT 1 FROM entry_summary
            \\  WHERE length(summary) > 0 AND substr(summary, 1, length(?1)) <> ?1
            \\  UNION ALL
            \\  SELECT 1 FROM chat_conversation
            \\  WHERE length(title) > 0 AND substr(title, 1, length(?1)) <> ?1
            \\  UNION ALL
            \\  SELECT 1 FROM chat_event
            \\  WHERE length(event) > 0 AND substr(event, 1, length(?1)) <> ?1
            \\  UNION ALL
            \\  SELECT 1 FROM chat_embedding
            \\  WHERE length(chunk_text) > 0 AND substr(chunk_text, 1, length(?1)) <> ?1
            \\  UNION ALL
            \\  SELECT 1 FROM chat_summary
            \\  WHERE length(summary) > 0 AND substr(summary, 1, length(?1)) <> ?1
            \\  UNION ALL
            \\  SELECT 1 FROM semantic_fact
            \\  WHERE (length(subject) > 0 AND substr(subject, 1, length(?1)) <> ?1)
            \\     OR (length(fact) > 0 AND substr(fact, 1, length(?1)) <> ?1)
            \\     OR (length(origin_text) > 0 AND substr(origin_text, 1, length(?1)) <> ?1)
            \\  UNION ALL
            \\  SELECT 1 FROM episodic_event
            \\  WHERE (length(event) > 0 AND substr(event, 1, length(?1)) <> ?1)
            \\     OR (length(origin_text) > 0 AND substr(origin_text, 1, length(?1)) <> ?1)
            \\  UNION ALL
            \\  SELECT 1 FROM agent_instruction
            \\  WHERE key = 'user' AND length(value) > 0
            \\    AND substr(value, 1, length(?1)) <> ?1
            \\);
        ;
        var rows = KvRows.init(self.allocator);
        defer rows.deinit();
        const outcome = self.db.query(
            sql,
            &.{.{ .text = vault_mod.field_prefix }},
            &rows,
            KvRows.collect,
        );
        if (outcome != .ok) return error.SqliteQueryFailed;
        if (rows.failed) return error.SqlitePageFailed;
        return rows.rows.items.len > 0;
    }

    /// Rewrite every stored field into (or out of) the encrypted form. The
    /// caller persists the operation flag before the walk, and the prefix
    /// keeps reads correct if a crash leaves a mixed state. `updated_at` is
    /// left alone so embeddings and summaries do not go stale.
    pub fn setRowsEncrypted(self: *Store, encrypting: bool) !void {
        const v = self.vault orelse return error.VaultUnavailable;

        var last_id: i64 = 0;
        while (true) {
            var rows = QueryRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                "SELECT id, title FROM journal_entry WHERE id > ?1 ORDER BY id LIMIT 32;",
                &.{.{ .integer = last_id }},
                &rows,
                QueryRows.collect,
            );
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_id = row.id;
                const stored_body = try self.loadStoredColumn("journal_entry", "body", row.id);
                defer self.allocator.free(stored_body);
                const new_title = try rewriteField(self.allocator, v, encrypting, vault_mod.aad_entry_title, row.title);
                defer self.allocator.free(new_title);
                const new_body = try rewriteField(self.allocator, v, encrypting, vault_mod.aad_entry_body, stored_body);
                defer self.allocator.free(new_body);
                if (std.mem.eql(u8, new_title, row.title) and std.mem.eql(u8, new_body, stored_body)) continue;
                const write_outcome = self.db.exec(&.{.{
                    .sql = "UPDATE journal_entry SET title = ?1, body = ?2 WHERE id = ?3;",
                    .params = &.{ .{ .text = new_title }, .{ .text = new_body }, .{ .integer = row.id } },
                }});
                if (write_outcome != .ok) return error.SqliteWriteFailed;
            }
        }

        var last_rowid: i64 = 0;
        while (true) {
            var rows = ChunkTextRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                "SELECT rowid, chunk_text FROM entry_embedding WHERE rowid > ?1 ORDER BY rowid LIMIT 32;",
                &.{.{ .integer = last_rowid }},
                &rows,
                ChunkTextRows.collect,
            );
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_rowid = row.rowid;
                const new_text = try rewriteField(self.allocator, v, encrypting, vault_mod.aad_chunk_text, row.text);
                defer self.allocator.free(new_text);
                if (std.mem.eql(u8, new_text, row.text)) continue;
                const write_outcome = self.db.exec(&.{.{
                    .sql = "UPDATE entry_embedding SET chunk_text = ?1 WHERE rowid = ?2;",
                    .params = &.{ .{ .text = new_text }, .{ .integer = row.rowid } },
                }});
                if (write_outcome != .ok) return error.SqliteWriteFailed;
            }
        }

        // INTEGER PRIMARY KEY `entry_id` is the rowid. `SELECT rowid` names the
        // column `entry_id`, so page by `entry_id` and alias it for ChunkTextRows.
        var last_summary_id: i64 = 0;
        while (true) {
            var rows = ChunkTextRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                "SELECT entry_id AS rowid, summary AS chunk_text FROM entry_summary WHERE entry_id > ?1 ORDER BY entry_id LIMIT 32;",
                &.{.{ .integer = last_summary_id }},
                &rows,
                ChunkTextRows.collect,
            );
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_summary_id = row.rowid;
                const new_text = try rewriteField(self.allocator, v, encrypting, vault_mod.aad_entry_summary, row.text);
                defer self.allocator.free(new_text);
                if (std.mem.eql(u8, new_text, row.text)) continue;
                const write_outcome = self.db.exec(&.{.{
                    .sql = "UPDATE entry_summary SET summary = ?1 WHERE entry_id = ?2;",
                    .params = &.{ .{ .text = new_text }, .{ .integer = row.rowid } },
                }});
                if (write_outcome != .ok) return error.SqliteWriteFailed;
            }
        }

        var last_chat_id: i64 = 0;
        while (true) {
            var rows = ChatRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                "SELECT id, title FROM chat_conversation WHERE id > ?1 ORDER BY id LIMIT 32;",
                &.{.{ .integer = last_chat_id }},
                &rows,
                ChatRows.collect,
            );
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_chat_id = row.id;
                const new_title = try rewriteField(self.allocator, v, encrypting, vault_mod.aad_chat_title, row.title);
                defer self.allocator.free(new_title);
                if (std.mem.eql(u8, new_title, row.title)) continue;
                const write_outcome = self.db.exec(&.{.{
                    .sql = "UPDATE chat_conversation SET title = ?1 WHERE id = ?2;",
                    .params = &.{ .{ .text = new_title }, .{ .integer = row.id } },
                }});
                if (write_outcome != .ok) return error.SqliteWriteFailed;
            }
        }

        var last_event_conversation: i64 = 0;
        var last_event_seq: i64 = -1;
        while (true) {
            var rows = ChatEventRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                "SELECT conversation_id, seq, event FROM chat_event WHERE conversation_id > ?1 OR (conversation_id = ?1 AND seq > ?2) ORDER BY conversation_id, seq LIMIT 32;",
                &.{ .{ .integer = last_event_conversation }, .{ .integer = last_event_seq } },
                &rows,
                ChatEventRows.collect,
            );
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_event_conversation = row.conversation_id;
                last_event_seq = row.seq;
                var aad_buf: [80]u8 = undefined;
                const aad = chatEventAad(&aad_buf, row.conversation_id, row.seq);
                const new_event = try rewriteField(self.allocator, v, encrypting, aad, row.event);
                defer self.allocator.free(new_event);
                if (std.mem.eql(u8, new_event, row.event)) continue;
                const write_outcome = self.db.exec(&.{.{
                    .sql = "UPDATE chat_event SET event = ?1 WHERE conversation_id = ?2 AND seq = ?3;",
                    .params = &.{ .{ .text = new_event }, .{ .integer = row.conversation_id }, .{ .integer = row.seq } },
                }});
                if (write_outcome != .ok) return error.SqliteWriteFailed;
            }
        }

        var last_chat_embed_rowid: i64 = 0;
        while (true) {
            var rows = ChatEmbedRewriteRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                "SELECT rowid, conversation_id, chunk_index, chunk_text FROM chat_embedding WHERE rowid > ?1 ORDER BY rowid LIMIT 32;",
                &.{.{ .integer = last_chat_embed_rowid }},
                &rows,
                ChatEmbedRewriteRows.collect,
            );
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_chat_embed_rowid = row.rowid;
                var aad_buf: [80]u8 = undefined;
                const aad = vault_mod.aadChatChunk(&aad_buf, row.conversation_id, row.chunk_index);
                const new_text = try rewriteField(self.allocator, v, encrypting, aad, row.text);
                defer self.allocator.free(new_text);
                if (std.mem.eql(u8, new_text, row.text)) continue;
                const write_outcome = self.db.exec(&.{.{
                    .sql = "UPDATE chat_embedding SET chunk_text = ?1 WHERE rowid = ?2;",
                    .params = &.{ .{ .text = new_text }, .{ .integer = row.rowid } },
                }});
                if (write_outcome != .ok) return error.SqliteWriteFailed;
            }
        }

        var last_chat_summary_id: i64 = 0;
        while (true) {
            var rows = ChunkTextRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                "SELECT conversation_id AS rowid, summary AS chunk_text FROM chat_summary WHERE conversation_id > ?1 ORDER BY conversation_id LIMIT 32;",
                &.{.{ .integer = last_chat_summary_id }},
                &rows,
                ChunkTextRows.collect,
            );
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_chat_summary_id = row.rowid;
                var aad_buf: [80]u8 = undefined;
                const aad = vault_mod.aadChatSummary(&aad_buf, row.rowid);
                const new_text = try rewriteField(self.allocator, v, encrypting, aad, row.text);
                defer self.allocator.free(new_text);
                if (std.mem.eql(u8, new_text, row.text)) continue;
                const write_outcome = self.db.exec(&.{.{
                    .sql = "UPDATE chat_summary SET summary = ?1 WHERE conversation_id = ?2;",
                    .params = &.{ .{ .text = new_text }, .{ .integer = row.rowid } },
                }});
                if (write_outcome != .ok) return error.SqliteWriteFailed;
            }
        }

        var last_fact_id: i64 = 0;
        while (true) {
            var rows = MemoryRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                "SELECT id, subject, fact, origin_text FROM semantic_fact WHERE id > ?1 ORDER BY id LIMIT 32;",
                &.{.{ .integer = last_fact_id }},
                &rows,
                MemoryRows.collect,
            );
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_fact_id = row.id;
                var subject_aad: [80]u8 = undefined;
                var fact_aad: [80]u8 = undefined;
                var origin_aad: [80]u8 = undefined;
                const new_subject = try rewriteField(self.allocator, v, encrypting, vault_mod.aadSemanticSubject(&subject_aad, row.id), row.subject);
                defer self.allocator.free(new_subject);
                const new_fact = try rewriteField(self.allocator, v, encrypting, vault_mod.aadSemanticFact(&fact_aad, row.id), row.fact);
                defer self.allocator.free(new_fact);
                const new_origin = if (row.origin_text.len == 0)
                    row.origin_text
                else
                    try rewriteField(self.allocator, v, encrypting, vault_mod.aadSemanticOrigin(&origin_aad, row.id), row.origin_text);
                defer if (row.origin_text.len > 0) self.allocator.free(new_origin);
                if (std.mem.eql(u8, new_subject, row.subject) and
                    std.mem.eql(u8, new_fact, row.fact) and
                    std.mem.eql(u8, new_origin, row.origin_text)) continue;
                const write_outcome = self.db.exec(&.{.{
                    .sql = "UPDATE semantic_fact SET subject = ?1, fact = ?2, origin_text = ?3 WHERE id = ?4;",
                    .params = &.{ .{ .text = new_subject }, .{ .text = new_fact }, .{ .text = new_origin }, .{ .integer = row.id } },
                }});
                if (write_outcome != .ok) return error.SqliteWriteFailed;
            }
        }

        var last_event_id: i64 = 0;
        while (true) {
            var rows = MemoryRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                "SELECT id, event AS fact, origin_text FROM episodic_event WHERE id > ?1 ORDER BY id LIMIT 32;",
                &.{.{ .integer = last_event_id }},
                &rows,
                MemoryRows.collect,
            );
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            if (rows.rows.items.len == 0) break;
            for (rows.rows.items) |row| {
                last_event_id = row.id;
                var aad_buf: [80]u8 = undefined;
                var origin_aad: [80]u8 = undefined;
                const new_event = try rewriteField(self.allocator, v, encrypting, vault_mod.aadEpisodicEvent(&aad_buf, row.id), row.fact);
                defer self.allocator.free(new_event);
                const new_origin = if (row.origin_text.len == 0)
                    row.origin_text
                else
                    try rewriteField(self.allocator, v, encrypting, vault_mod.aadEpisodicOrigin(&origin_aad, row.id), row.origin_text);
                defer if (row.origin_text.len > 0) self.allocator.free(new_origin);
                if (std.mem.eql(u8, new_event, row.fact) and std.mem.eql(u8, new_origin, row.origin_text)) continue;
                const write_outcome = self.db.exec(&.{.{
                    .sql = "UPDATE episodic_event SET event = ?1, origin_text = ?2 WHERE id = ?3;",
                    .params = &.{ .{ .text = new_event }, .{ .text = new_origin }, .{ .integer = row.id } },
                }});
                if (write_outcome != .ok) return error.SqliteWriteFailed;
            }
        }

        {
            var rows = KvRows.init(self.allocator);
            defer rows.deinit();
            const outcome = self.db.query(
                "SELECT key, value FROM agent_instruction;",
                &.{},
                &rows,
                KvRows.collect,
            );
            if (outcome != .ok) return error.SqliteQueryFailed;
            if (rows.failed) return error.SqlitePageFailed;
            for (rows.rows.items) |row| {
                if (!std.mem.eql(u8, row.key, agent_user_instruction_key)) continue;
                const new_value = try rewriteField(self.allocator, v, encrypting, vault_mod.aad_agent_user, row.value);
                defer self.allocator.free(new_value);
                if (std.mem.eql(u8, new_value, row.value)) continue;
                const write_outcome = self.db.exec(&.{.{
                    .sql = "UPDATE agent_instruction SET value = ?1 WHERE key = ?2;",
                    .params = &.{ .{ .text = new_value }, .{ .text = row.key } },
                }});
                if (write_outcome != .ok) return error.SqliteWriteFailed;
            }
        }
    }

    /// Zero the bytes of deleted or overwritten rows from now on. The setting
    /// is per-connection, so main re-applies it on every launch.
    pub fn setSecureDelete(self: *Store, on: bool) !void {
        try self.db.write_db.exec(if (on) "PRAGMA secure_delete=ON;" else "PRAGMA secure_delete=OFF;");
    }

    /// Remove overwritten bytes from the database file: checkpoint the WAL so
    /// old frames are gone, then rebuild the file so free pages come back
    /// without them. Uses the writer connection directly because VACUUM cannot
    /// run inside a transaction and the relational authorizer denies the ATTACH
    /// that VACUUM performs internally. The reader is closed for the rebuild;
    /// VACUUM needs exclusive access to the file.
    ///
    /// `setRelationalAuthorizer` is supposed to run under the store writer
    /// lock. Only the loop thread touches SQLite, so this stays single-threaded.
    pub fn scrubStorage(self: *Store) !void {
        if (self.fail_next_scrub) {
            self.fail_next_scrub = false;
            return error.Busy;
        }
        const had_reader = self.db.read_db != null;
        if (self.db.read_db) |*read| {
            read.close();
            self.db.read_db = null;
        }

        try self.db.write_db.setRelationalAuthorizer(false);
        var first_err: ?anyerror = null;
        self.checkpointAndVacuum() catch |err| {
            first_err = err;
        };
        self.db.write_db.setRelationalAuthorizer(true) catch |err| {
            if (first_err == null) first_err = err;
        };
        if (had_reader and self.db.read_db == null) {
            reopenReader(self) catch |err| {
                if (first_err == null) first_err = err;
            };
        }
        if (first_err) |err| return err;
    }

    fn checkpointAndVacuum(self: *Store) !void {
        try self.db.write_db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        try self.db.write_db.exec("VACUUM;");
        try self.db.write_db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    }
};

fn reopenReader(self: *Store) !void {
    var read_db = try @TypeOf(self.db.write_db).open(self.db.path);
    errdefer read_db.close();
    try read_db.exec("PRAGMA busy_timeout=250;");
    try read_db.exec("PRAGMA foreign_keys=ON;");
    try read_db.exec("PRAGMA query_only=ON;");
    try read_db.installRelationalAuthorizer();
    self.db.read_db = read_db;
}

fn rewriteField(allocator: std.mem.Allocator, v: *vault_mod.Vault, encrypting: bool, aad: []const u8, stored: []const u8) ![]u8 {
    if (encrypting) {
        if (vault_mod.Vault.isEncryptedField(stored)) {
            // Authenticate a prefixed value before treating it as ciphertext.
            // A plaintext prefix collision is encrypted as ordinary text.
            const opened = v.decryptField(allocator, aad, stored) catch |err| switch (err) {
                error.CorruptField => return v.encryptField(allocator, aad, stored),
                else => return err,
            };
            allocator.free(opened);
            return allocator.dupe(u8, stored);
        }
        return v.encryptField(allocator, aad, stored);
    }
    if (!try vault_mod.Vault.hasCiphertextEnvelope(allocator, stored)) {
        return allocator.dupe(u8, stored);
    }
    return v.decryptField(allocator, aad, stored);
}

const SearchMatch = struct {
    row: QueryRows.Row,
    excerpt: []const u8,

    fn newestFirst(_: void, first: SearchMatch, second: SearchMatch) bool {
        return switch (std.mem.order(u8, first.row.date, second.row.date)) {
            .gt => true,
            .lt => false,
            .eq => first.row.id > second.row.id,
        };
    }
};

const ChatEventRole = enum {
    assistant,
    user,

    fn json(self: ChatEventRole) []const u8 {
        return switch (self) {
            .assistant => "assistant",
            .user => "user",
        };
    }
};

const ChatSearchMatch = struct {
    conversation_id: i64,
    excerpt: []const u8,
    role: ?ChatEventRole,
    seq: ?i64,
    title: []const u8,
    updated_at: []const u8,

    fn newerFirst(_: void, first: ChatSearchMatch, second: ChatSearchMatch) bool {
        return switch (std.mem.order(u8, first.updated_at, second.updated_at)) {
            .gt => true,
            .lt => false,
            .eq => blk: {
                const first_seq = first.seq orelse -1;
                const second_seq = second.seq orelse -1;
                if (first_seq != second_seq) break :blk first_seq > second_seq;
                break :blk first.conversation_id > second.conversation_id;
            },
        };
    }
};

fn capNewestMessageHits(matches: *std.ArrayList(ChatSearchMatch), before: usize, max_hits: usize) void {
    const added = matches.items.len - before;
    if (added <= max_hits) return;
    const drop = added - max_hits;
    const kept = matches.items[before + drop ..];
    std.mem.copyForwards(ChatSearchMatch, matches.items[before..][0..kept.len], kept);
    matches.shrinkRetainingCapacity(before + kept.len);
}

const SemanticHit = struct {
    id: i64,
    date: []const u8,
    title: []const u8,
    snippet: []const u8,
    score: f32,

    fn higherScore(_: void, first: SemanticHit, second: SemanticHit) bool {
        return first.score > second.score;
    }
};

const MemoryHit = struct {
    date: []const u8,
    id: i64,
    score: f32,
    source_id: i64,
    source_type: []const u8,
    subject: []const u8,
    text: []const u8,

    fn higherScore(_: void, first: MemoryHit, second: MemoryHit) bool {
        return first.score > second.score;
    }
};

const MemoryListItem = struct {
    id: i64,
    occurred_at: []const u8 = "",
    pinned: bool,
    source_id: i64,
    source_title: []const u8 = "",
    source_type: []const u8,
    subject: []const u8 = "",
    text: []const u8,
    updated_at: []const u8,

    fn newerFirst(_: void, first: MemoryListItem, second: MemoryListItem) bool {
        return switch (std.mem.order(u8, first.updated_at, second.updated_at)) {
            .gt => true,
            .lt => false,
            .eq => first.id > second.id,
        };
    }

    fn laterEventFirst(_: void, first: MemoryListItem, second: MemoryListItem) bool {
        const first_dated = isEventDate(first.occurred_at);
        const second_dated = isEventDate(second.occurred_at);
        if (!first_dated and !second_dated) {
            return first.id > second.id;
        }
        if (!first_dated) return false;
        if (!second_dated) return true;
        return switch (std.mem.order(u8, first.occurred_at, second.occurred_at)) {
            .gt => true,
            .lt => false,
            .eq => first.id > second.id,
        };
    }
};

const MemorySearchMatch = struct {
    excerpt: []const u8,
    item: MemoryListItem,
    kind: MemoryKind,

    fn newerFirst(_: void, first: MemorySearchMatch, second: MemorySearchMatch) bool {
        return MemoryListItem.newerFirst({}, first.item, second.item);
    }
};

fn appendMemorySearchHits(
    arena: std.mem.Allocator,
    matches: *std.ArrayList(MemorySearchMatch),
    items: []const MemoryListItem,
    kind: MemoryKind,
    query: []const u8,
) !void {
    for (items) |item| {
        if (!memorySearchItemMatches(kind, item, query)) continue;
        const excerpt_buf = try arena.alloc(u8, 160);
        try matches.append(arena, .{
            .excerpt = memorySearchExcerpt(kind, item, query, excerpt_buf),
            .item = item,
            .kind = kind,
        });
    }
}

fn memorySearchItemMatches(kind: MemoryKind, item: MemoryListItem, query: []const u8) bool {
    return switch (kind) {
        .profile, .event => std.ascii.indexOfIgnoreCase(item.text, query) != null,
        .fact => std.ascii.indexOfIgnoreCase(item.subject, query) != null or
            std.ascii.indexOfIgnoreCase(item.text, query) != null,
    };
}

fn memorySearchExcerpt(kind: MemoryKind, item: MemoryListItem, query: []const u8, buf: []u8) []const u8 {
    return switch (kind) {
        .profile => excerptFor("", item.text, query, buf),
        .fact => excerptFor(item.text, "", query, buf),
        .event => excerptFor(item.text, "", query, buf),
    };
}

fn writeMemorySearchHit(writer: *std.Io.Writer, match: MemorySearchMatch) !void {
    try writer.writeAll("{\"kind\":");
    try writeJsonStringStreaming(writer, @tagName(match.kind));
    try writer.writeAll(",\"id\":");
    try writer.print("{d}", .{match.item.id});
    try writer.writeAll(",\"subject\":");
    try writeJsonStringStreaming(writer, if (match.kind == .fact) match.item.subject else "");
    try writer.writeAll(",\"fact\":");
    try writeJsonStringStreaming(writer, if (match.kind == .event) "" else match.item.text);
    try writer.writeAll(",\"event\":");
    try writeJsonStringStreaming(writer, if (match.kind == .event) match.item.text else "");
    try writer.writeAll(",\"excerpt\":");
    try writeJsonStringStreaming(writer, match.excerpt);
    try writer.writeAll(",\"updatedAt\":");
    try writeJsonStringStreaming(writer, match.item.updated_at);
    try writer.writeAll(",\"occurredAt\":");
    try writeJsonStringStreaming(writer, if (match.kind == .event) match.item.occurred_at else "");
    try writer.writeAll(",\"sourceTitle\":");
    try writeJsonStringStreaming(writer, if (match.kind == .event) match.item.source_title else "");
    try writer.writeByte('}');
}

fn isEventDate(value: []const u8) bool {
    if (value.len < 10) return false;
    inline for (.{ 0, 1, 2, 3, 5, 6, 8, 9 }) |index| {
        if (value[index] < '0' or value[index] > '9') return false;
    }
    return value[4] == '-' and value[7] == '-';
}

const LoadedSemantic = struct {
    fact: []const u8,
    hidden: i64,
    id: i64,
    kind: []const u8,
    origin_text: []const u8,
    pinned: i64,
    source_id: i64,
    source_type: []const u8,
    subject: []const u8,
};

const LoadedEvent = struct {
    hidden: i64,
    id: i64,
    occurred_at: []const u8,
    origin_text: []const u8,
    pinned: i64,
    source_id: i64,
    source_type: []const u8,
    text: []const u8,
};

fn writeMemoryList(writer: *std.Io.Writer, items: []const MemoryListItem, kind: MemoryKind) !void {
    for (items, 0..) |item, index| {
        if (index > 0) try writer.writeAll(",");
        try writer.writeAll("{\"id\":");
        try writer.print("{d}", .{item.id});
        switch (kind) {
            .profile => {
                try writer.writeAll(",\"fact\":");
                try writeJsonStringStreaming(writer, item.text);
            },
            .fact => {
                try writer.writeAll(",\"subject\":");
                try writeJsonStringStreaming(writer, item.subject);
                try writer.writeAll(",\"fact\":");
                try writeJsonStringStreaming(writer, item.text);
            },
            .event => {
                try writer.writeAll(",\"event\":");
                try writeJsonStringStreaming(writer, item.text);
                try writer.writeAll(",\"occurredAt\":");
                try writeJsonStringStreaming(writer, item.occurred_at);
                try writer.writeAll(",\"sourceTitle\":");
                try writeJsonStringStreaming(writer, item.source_title);
            },
        }
        try writer.writeAll(",\"updatedAt\":");
        try writeJsonStringStreaming(writer, item.updated_at);
        try writer.writeAll(",\"pinned\":");
        try writer.writeAll(if (item.pinned) "true" else "false");
        try writeMemorySource(writer, item.source_type, item.source_id);
        try writer.writeByte('}');
    }
}

fn encodeVector(allocator: std.mem.Allocator, vec: []const f32) ![]u8 {
    const blob = try allocator.alloc(u8, vec.len * @sizeOf(f32));
    for (vec, 0..) |val, vi| {
        const bits: u32 = @bitCast(val);
        std.mem.writeInt(u32, blob[vi * 4 ..][0..4], bits, .little);
    }
    return blob;
}

const RecentMessages = struct {
    allocator: std.mem.Allocator,
    roles: [chat_title_recent_messages]ChatEventRole = undefined,
    texts: [chat_title_recent_messages][]u8 = undefined,
    start: usize = 0,
    count: usize = 0,

    fn init(allocator: std.mem.Allocator) RecentMessages {
        return .{ .allocator = allocator };
    }

    fn deinit(self: *RecentMessages) void {
        var i: usize = 0;
        while (i < self.count) : (i += 1) {
            const index = (self.start + i) % chat_title_recent_messages;
            self.allocator.free(self.texts[index]);
        }
        self.count = 0;
    }

    fn push(self: *RecentMessages, role: ChatEventRole, text: []const u8) !void {
        const owned = try self.allocator.dupe(u8, text);
        if (self.count < chat_title_recent_messages) {
            self.roles[self.count] = role;
            self.texts[self.count] = owned;
            self.count += 1;
            return;
        }
        const index = self.start;
        self.allocator.free(self.texts[index]);
        self.roles[index] = role;
        self.texts[index] = owned;
        self.start = (self.start + 1) % chat_title_recent_messages;
    }

    fn format(self: *const RecentMessages) ![]u8 {
        var out = std.ArrayList(u8).empty;
        errdefer out.deinit(self.allocator);
        var i: usize = 0;
        while (i < self.count) : (i += 1) {
            const index = (self.start + i) % chat_title_recent_messages;
            try appendLabeledMessage(&out, self.allocator, self.roles[index], self.texts[index]);
        }
        return out.toOwnedSlice(self.allocator);
    }
};

fn appendLabeledMessage(
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    role: ChatEventRole,
    text: []const u8,
) !void {
    const label: []const u8 = switch (role) {
        .assistant => "Sage",
        .user => "User",
    };
    if (out.items.len > 0) try out.appendSlice(allocator, "\n\n");
    try out.appendSlice(allocator, label);
    try out.appendSlice(allocator, ": ");
    try out.appendSlice(allocator, text);
}

fn appendTranscriptEvent(
    out: *std.ArrayList(u8),
    recent: *RecentMessages,
    allocator: std.mem.Allocator,
    raw: []const u8,
) !void {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{ .allocate = .alloc_always }) catch return;
    defer parsed.deinit();
    const extracted = readChatEventText(parsed.value) orelse return;
    try appendLabeledMessage(out, allocator, extracted.role, extracted.text);
    try recent.push(extracted.role, extracted.text);
}

fn readChatEventText(value: std.json.Value) ?struct { role: ChatEventRole, text: []const u8 } {
    if (value != .object) return null;
    const obj = value.object;
    const type_val = obj.get("type") orelse return null;
    if (type_val != .string) return null;
    const role: ChatEventRole = if (std.mem.eql(u8, type_val.string, "message.received"))
        .user
    else if (std.mem.eql(u8, type_val.string, "message.completed"))
        .assistant
    else
        return null;
    const data_val = obj.get("data") orelse return null;
    if (data_val != .object) return null;
    const message_val = data_val.object.get("message") orelse return null;
    if (message_val != .string) return null;
    const trimmed = std.mem.trim(u8, message_val.string, " \t\r\n");
    if (trimmed.len == 0) return null;
    return .{ .role = role, .text = trimmed };
}

fn profileTextSeen(existing: []const []const u8, incoming: []const NewFact, candidate: []const u8) bool {
    for (existing) |item| {
        if (profileTextEqual(item, candidate)) return true;
    }
    for (incoming) |item| {
        if (!std.mem.eql(u8, item.kind, "profile")) continue;
        if (profileTextEqual(item.fact, candidate)) return true;
    }
    return false;
}

fn profileTextEqual(left: []const u8, right: []const u8) bool {
    return std.ascii.eqlIgnoreCase(
        std.mem.trim(u8, left, " \t\r\n"),
        std.mem.trim(u8, right, " \t\r\n"),
    );
}

fn memoryTextSeen(existing: []const []const u8, candidate: []const u8) bool {
    for (existing) |item| {
        if (profileTextEqual(item, candidate)) return true;
    }
    return false;
}

fn writeChatThinking(writer: *std.Io.Writer, thinking: ?i64) !void {
    if (thinking) |value| {
        try writer.writeAll(if (value == 0) "false" else "true");
    } else {
        try writer.writeAll("null");
    }
}

fn writeChatContextLength(writer: *std.Io.Writer, context_length: ?i64) !void {
    if (context_length) |value| {
        try writer.print("{d}", .{value});
    } else {
        try writer.writeAll("null");
    }
}

fn chatThinkingValue(thinking: ?bool) native_sdk.relational_store.Value {
    return if (thinking) |value|
        .{ .integer = if (value) 1 else 0 }
    else
        .null_value;
}

fn chatContextLengthValue(context_length: ?i64) native_sdk.relational_store.Value {
    return if (context_length) |value|
        .{ .integer = value }
    else
        .null_value;
}

fn readChatThinking(payload: []const u8) !?bool {
    const raw = jsonRaw(payload, "thinking") orelse return null;
    if (std.mem.eql(u8, raw, "null")) return null;
    if (std.mem.eql(u8, raw, "true")) return true;
    if (std.mem.eql(u8, raw, "false")) return false;
    return error.InvalidRequest;
}

fn writeChatMeta(writer: *std.Io.Writer, id: i64, title: []const u8, updated_at: []const u8) !void {
    try writer.writeAll("{\"id\":");
    try writer.print("{d}", .{id});
    try writer.writeAll(",\"title\":");
    try writeJsonString(writer, title);
    try writer.writeAll(",\"updatedAt\":");
    try writeJsonString(writer, updated_at);
    try writer.writeByte('}');
}

fn writeChatSearchHit(writer: *std.Io.Writer, match: ChatSearchMatch) !void {
    try writer.writeAll("{\"conversationId\":");
    try writer.print("{d}", .{match.conversation_id});
    try writer.writeAll(",\"title\":");
    try writeJsonString(writer, match.title);
    try writer.writeAll(",\"updatedAt\":");
    try writeJsonString(writer, match.updated_at);
    try writer.writeAll(",\"excerpt\":");
    try writeJsonString(writer, match.excerpt);
    try writer.writeAll(",\"role\":");
    if (match.role) |role| {
        try writeJsonString(writer, role.json());
    } else {
        try writer.writeAll("null");
    }
    try writer.writeAll(",\"seq\":");
    if (match.seq) |seq| {
        try writer.print("{d}", .{seq});
    } else {
        try writer.writeAll("null");
    }
    try writer.writeByte('}');
}

pub fn cosineSimilarity(left: []const f32, right: []const f32) f32 {
    const n = @min(left.len, right.len);
    var dot: f32 = 0;
    var left_norm: f32 = 0;
    var right_norm: f32 = 0;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        dot += left[i] * right[i];
        left_norm += left[i] * left[i];
        right_norm += right[i] * right[i];
    }
    const denom = @sqrt(left_norm) * @sqrt(right_norm);
    if (denom == 0) return 0;
    return dot / denom;
}

fn decodeVectorAlloc(allocator: std.mem.Allocator, blob: []const u8) ![]f32 {
    if (blob.len < 4 or blob.len % 4 != 0) return error.InvalidEmbedding;
    const count = blob.len / 4;
    const vec = try allocator.alloc(f32, count);
    var i: usize = 0;
    while (i < count) : (i += 1) {
        const bits = std.mem.readInt(u32, blob[i * 4 ..][0..4], .little);
        vec[i] = @bitCast(bits);
    }
    return vec;
}

/// Collects (rowid, chunk_text) rows for the encryption rewrite pass.
const ChunkTextRows = struct {
    allocator: std.mem.Allocator,
    rows: std.ArrayList(Row) = .empty,
    failed: bool = false,

    const Row = struct {
        rowid: i64 = 0,
        text: []u8 = &.{},
    };

    fn init(allocator: std.mem.Allocator) ChunkTextRows {
        return .{ .allocator = allocator };
    }

    fn deinit(self: *ChunkTextRows) void {
        for (self.rows.items) |row| {
            if (row.text.len > 0) self.allocator.free(row.text);
        }
        self.rows.deinit(self.allocator);
    }

    fn collect(context: *anyopaque, bytes: []const u8) void {
        const self: *ChunkTextRows = @ptrCast(@alignCast(context));
        self.appendPage(bytes) catch {
            self.failed = true;
        };
    }

    fn appendPage(self: *ChunkTextRows, bytes: []const u8) !void {
        var at: usize = 0;
        const column_count = try readU32(bytes, &at);
        const row_count = try readU32(bytes, &at);
        var names: [8][]const u8 = undefined;
        if (column_count > names.len) return error.TooManyColumns;
        for (0..column_count) |index| {
            names[index] = try readBytes(bytes, &at);
        }
        for (0..row_count) |_| {
            var row: Row = .{};
            errdefer if (row.text.len > 0) self.allocator.free(row.text);
            for (0..column_count) |index| {
                const cell = try readCell(bytes, &at);
                if (std.mem.eql(u8, names[index], "rowid")) {
                    row.rowid = cellInteger(cell);
                } else if (std.mem.eql(u8, names[index], "chunk_text")) {
                    row.text = switch (cell) {
                        .text, .blob => |cell_bytes| try self.allocator.dupe(u8, cell_bytes),
                        else => try self.allocator.dupe(u8, ""),
                    };
                }
            }
            try self.rows.append(self.allocator, row);
        }
    }
};

const ChatEmbedRewriteRows = struct {
    allocator: std.mem.Allocator,
    rows: std.ArrayList(Row) = .empty,
    failed: bool = false,

    const Row = struct {
        chunk_index: i64 = 0,
        conversation_id: i64 = 0,
        rowid: i64 = 0,
        text: []u8 = &.{},
    };

    fn init(allocator: std.mem.Allocator) ChatEmbedRewriteRows {
        return .{ .allocator = allocator };
    }

    fn deinit(self: *ChatEmbedRewriteRows) void {
        for (self.rows.items) |row| {
            if (row.text.len > 0) self.allocator.free(row.text);
        }
        self.rows.deinit(self.allocator);
    }

    fn collect(context: *anyopaque, bytes: []const u8) void {
        const self: *ChatEmbedRewriteRows = @ptrCast(@alignCast(context));
        self.appendPage(bytes) catch {
            self.failed = true;
        };
    }

    fn appendPage(self: *ChatEmbedRewriteRows, bytes: []const u8) !void {
        var at: usize = 0;
        const column_count = try readU32(bytes, &at);
        const row_count = try readU32(bytes, &at);
        var names: [8][]const u8 = undefined;
        if (column_count > names.len) return error.TooManyColumns;
        for (0..column_count) |index| {
            names[index] = try readBytes(bytes, &at);
        }
        for (0..row_count) |_| {
            var row: Row = .{};
            errdefer if (row.text.len > 0) self.allocator.free(row.text);
            for (0..column_count) |index| {
                const cell = try readCell(bytes, &at);
                const name = names[index];
                if (std.mem.eql(u8, name, "rowid")) {
                    row.rowid = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "conversation_id")) {
                    row.conversation_id = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "chunk_index")) {
                    row.chunk_index = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "chunk_text")) {
                    row.text = try dupeCell(self.allocator, cell);
                }
            }
            try self.rows.append(self.allocator, row);
        }
    }
};

const DreamPendingRows = struct {
    allocator: std.mem.Allocator,
    rows: std.ArrayList(DreamItem) = .empty,
    failed: bool = false,

    fn init(allocator: std.mem.Allocator) DreamPendingRows {
        return .{ .allocator = allocator };
    }

    fn deinit(self: *DreamPendingRows) void {
        self.rows.deinit(self.allocator);
    }

    fn toOwnedSlice(self: *DreamPendingRows) ![]DreamItem {
        const slice = try self.rows.toOwnedSlice(self.allocator);
        self.rows = .empty;
        return slice;
    }

    fn collect(context: *anyopaque, bytes: []const u8) void {
        const self: *DreamPendingRows = @ptrCast(@alignCast(context));
        self.appendPage(bytes) catch {
            self.failed = true;
        };
    }

    fn appendPage(self: *DreamPendingRows, bytes: []const u8) !void {
        var at: usize = 0;
        const column_count = try readU32(bytes, &at);
        const row_count = try readU32(bytes, &at);
        var names: [8][]const u8 = undefined;
        if (column_count > names.len) return error.TooManyColumns;
        for (0..column_count) |index| {
            names[index] = try readBytes(bytes, &at);
        }
        for (0..row_count) |_| {
            var source: ?DreamSource = null;
            var id: i64 = 0;
            var needs_memory_extraction = false;
            for (0..column_count) |index| {
                const cell = try readCell(bytes, &at);
                const name = names[index];
                if (std.mem.eql(u8, name, "source_type")) {
                    const text = switch (cell) {
                        .text, .blob => |cell_bytes| cell_bytes,
                        else => "",
                    };
                    source = DreamSource.parse(text);
                } else if (std.mem.eql(u8, name, "source_id")) {
                    id = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "needs_memory_extraction")) {
                    needs_memory_extraction = cellInteger(cell) != 0;
                }
            }
            if (source) |kind| {
                try self.rows.append(self.allocator, .{
                    .source = kind,
                    .id = id,
                    .needs_memory_extraction = needs_memory_extraction,
                });
            }
        }
    }
};

const MemoryRows = struct {
    allocator: std.mem.Allocator,
    rows: std.ArrayList(Row) = .empty,
    failed: bool = false,

    const Row = struct {
        embedding: []u8 = &.{},
        fact: []u8 = &.{},
        hidden: i64 = 0,
        id: i64 = 0,
        kind: []u8 = &.{},
        occurred_at: []u8 = &.{},
        origin_text: []u8 = &.{},
        pinned: i64 = 0,
        source_id: i64 = 0,
        source_title: []u8 = &.{},
        source_type: []u8 = &.{},
        subject: []u8 = &.{},
        updated_at: []u8 = &.{},
    };

    fn init(allocator: std.mem.Allocator) MemoryRows {
        return .{ .allocator = allocator };
    }

    fn deinit(self: *MemoryRows) void {
        for (self.rows.items) |row| {
            if (row.embedding.len > 0) self.allocator.free(row.embedding);
            if (row.fact.len > 0) self.allocator.free(row.fact);
            if (row.kind.len > 0) self.allocator.free(row.kind);
            if (row.occurred_at.len > 0) self.allocator.free(row.occurred_at);
            if (row.origin_text.len > 0) self.allocator.free(row.origin_text);
            if (row.source_title.len > 0) self.allocator.free(row.source_title);
            if (row.source_type.len > 0) self.allocator.free(row.source_type);
            if (row.subject.len > 0) self.allocator.free(row.subject);
            if (row.updated_at.len > 0) self.allocator.free(row.updated_at);
        }
        self.rows.deinit(self.allocator);
    }

    fn collect(context: *anyopaque, bytes: []const u8) void {
        const self: *MemoryRows = @ptrCast(@alignCast(context));
        self.appendPage(bytes) catch {
            self.failed = true;
        };
    }

    fn appendPage(self: *MemoryRows, bytes: []const u8) !void {
        var at: usize = 0;
        const column_count = try readU32(bytes, &at);
        const row_count = try readU32(bytes, &at);
        var names: [16][]const u8 = undefined;
        if (column_count > names.len) return error.TooManyColumns;
        for (0..column_count) |index| {
            names[index] = try readBytes(bytes, &at);
        }
        for (0..row_count) |_| {
            var row: Row = .{};
            errdefer {
                if (row.embedding.len > 0) self.allocator.free(row.embedding);
                if (row.fact.len > 0) self.allocator.free(row.fact);
                if (row.kind.len > 0) self.allocator.free(row.kind);
                if (row.occurred_at.len > 0) self.allocator.free(row.occurred_at);
                if (row.origin_text.len > 0) self.allocator.free(row.origin_text);
                if (row.source_title.len > 0) self.allocator.free(row.source_title);
                if (row.source_type.len > 0) self.allocator.free(row.source_type);
                if (row.subject.len > 0) self.allocator.free(row.subject);
                if (row.updated_at.len > 0) self.allocator.free(row.updated_at);
            }
            for (0..column_count) |index| {
                const cell = try readCell(bytes, &at);
                const name = names[index];
                if (std.mem.eql(u8, name, "id")) {
                    row.id = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "subject")) {
                    row.subject = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "fact")) {
                    row.fact = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "kind")) {
                    row.kind = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "occurred_at")) {
                    row.occurred_at = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "origin_text")) {
                    row.origin_text = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "updated_at")) {
                    row.updated_at = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "embedding")) {
                    row.embedding = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "source_type")) {
                    row.source_type = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "source_id")) {
                    row.source_id = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "source_title")) {
                    row.source_title = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "pinned")) {
                    row.pinned = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "hidden")) {
                    row.hidden = cellInteger(cell);
                }
            }
            try self.rows.append(self.allocator, row);
        }
    }
};

const EmbeddingRows = struct {
    allocator: std.mem.Allocator,
    rows: std.ArrayList(Row) = .empty,
    failed: bool = false,

    const Row = struct {
        entry_id: i64 = 0,
        chunk_index: i64 = 0,
        date: []u8 = &.{},
        title: []u8 = &.{},
        chunk_text: []u8 = &.{},
        embedding: []u8 = &.{},
    };

    fn init(allocator: std.mem.Allocator) EmbeddingRows {
        return .{ .allocator = allocator };
    }

    fn deinit(self: *EmbeddingRows) void {
        for (self.rows.items) |row| {
            if (row.date.len > 0) self.allocator.free(row.date);
            if (row.title.len > 0) self.allocator.free(row.title);
            if (row.chunk_text.len > 0) self.allocator.free(row.chunk_text);
            if (row.embedding.len > 0) self.allocator.free(row.embedding);
        }
        self.rows.deinit(self.allocator);
    }

    fn collect(context: *anyopaque, bytes: []const u8) void {
        const self: *EmbeddingRows = @ptrCast(@alignCast(context));
        self.appendPage(bytes) catch {
            self.failed = true;
        };
    }

    fn appendPage(self: *EmbeddingRows, bytes: []const u8) !void {
        var at: usize = 0;
        const column_count = try readU32(bytes, &at);
        const row_count = try readU32(bytes, &at);
        var names: [16][]const u8 = undefined;
        if (column_count > names.len) return error.TooManyColumns;
        for (0..column_count) |index| {
            names[index] = try readBytes(bytes, &at);
        }
        for (0..row_count) |_| {
            var row: Row = .{};
            errdefer {
                if (row.date.len > 0) self.allocator.free(row.date);
                if (row.title.len > 0) self.allocator.free(row.title);
                if (row.chunk_text.len > 0) self.allocator.free(row.chunk_text);
                if (row.embedding.len > 0) self.allocator.free(row.embedding);
            }
            for (0..column_count) |index| {
                const cell = try readCell(bytes, &at);
                const name = names[index];
                if (std.mem.eql(u8, name, "id")) {
                    row.entry_id = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "chunk_index")) {
                    row.chunk_index = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "entry_date")) {
                    row.date = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "title")) {
                    row.title = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "chunk_text")) {
                    row.chunk_text = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "embedding")) {
                    row.embedding = try dupeCell(self.allocator, cell);
                }
            }
            try self.rows.append(self.allocator, row);
        }
    }
};

const ChatRows = struct {
    allocator: std.mem.Allocator,
    rows: std.ArrayList(Row) = .empty,
    failed: bool = false,

    const Row = struct {
        id: i64 = 0,
        stream_index: i64 = 0,
        title: []u8 = &.{},
        events: []u8 = &.{},
        eve_session_id: []u8 = &.{},
        model: []u8 = &.{},
        thinking: ?i64 = null,
        context_length: ?i64 = null,
        title_locked: i64 = 0,
        created_at: []u8 = &.{},
        updated_at: []u8 = &.{},
    };

    fn init(allocator: std.mem.Allocator) ChatRows {
        return .{ .allocator = allocator };
    }

    fn deinit(self: *ChatRows) void {
        for (self.rows.items) |row| {
            if (row.title.len > 0) self.allocator.free(row.title);
            if (row.events.len > 0) self.allocator.free(row.events);
            if (row.eve_session_id.len > 0) self.allocator.free(row.eve_session_id);
            if (row.model.len > 0) self.allocator.free(row.model);
            if (row.created_at.len > 0) self.allocator.free(row.created_at);
            if (row.updated_at.len > 0) self.allocator.free(row.updated_at);
        }
        self.rows.deinit(self.allocator);
    }

    fn collect(context: *anyopaque, bytes: []const u8) void {
        const self: *ChatRows = @ptrCast(@alignCast(context));
        self.appendPage(bytes) catch {
            self.failed = true;
        };
    }

    fn appendPage(self: *ChatRows, bytes: []const u8) !void {
        var at: usize = 0;
        const column_count = try readU32(bytes, &at);
        const row_count = try readU32(bytes, &at);
        var names: [16][]const u8 = undefined;
        if (column_count > names.len) return error.TooManyColumns;
        for (0..column_count) |index| {
            names[index] = try readBytes(bytes, &at);
        }
        for (0..row_count) |_| {
            var row: Row = .{};
            errdefer {
                if (row.title.len > 0) self.allocator.free(row.title);
                if (row.events.len > 0) self.allocator.free(row.events);
                if (row.eve_session_id.len > 0) self.allocator.free(row.eve_session_id);
                if (row.model.len > 0) self.allocator.free(row.model);
                if (row.created_at.len > 0) self.allocator.free(row.created_at);
                if (row.updated_at.len > 0) self.allocator.free(row.updated_at);
            }
            for (0..column_count) |index| {
                const cell = try readCell(bytes, &at);
                const name = names[index];
                if (std.mem.eql(u8, name, "id")) {
                    row.id = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "stream_index")) {
                    row.stream_index = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "title")) {
                    row.title = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "events")) {
                    row.events = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "eve_session_id")) {
                    row.eve_session_id = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "model")) {
                    row.model = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "thinking")) {
                    row.thinking = cellOptionalInteger(cell);
                } else if (std.mem.eql(u8, name, "context_length")) {
                    row.context_length = cellOptionalInteger(cell);
                } else if (std.mem.eql(u8, name, "title_locked")) {
                    row.title_locked = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "created_at")) {
                    row.created_at = try dupeCell(self.allocator, cell);
                } else if (std.mem.eql(u8, name, "updated_at")) {
                    row.updated_at = try dupeCell(self.allocator, cell);
                }
            }
            try self.rows.append(self.allocator, row);
        }
    }
};

fn freeChatExportMetaItem(allocator: std.mem.Allocator, item: ChatExportMeta) void {
    if (item.created_at.len > 0) allocator.free(item.created_at);
    if (item.eve_session_id) |session_id| allocator.free(session_id);
    if (item.model.len > 0) allocator.free(item.model);
    if (item.title.len > 0) allocator.free(item.title);
    if (item.updated_at.len > 0) allocator.free(item.updated_at);
}

const ChatEventWrite = struct {
    params: [3]native_sdk.relational_store.Value,
    stored: []u8,
};

const ChatEventRows = struct {
    allocator: std.mem.Allocator,
    rows: std.ArrayList(Row) = .empty,
    failed: bool = false,

    const Row = struct {
        conversation_id: i64 = 0,
        seq: i64 = 0,
        event: []u8 = &.{},
    };

    fn init(allocator: std.mem.Allocator) ChatEventRows {
        return .{ .allocator = allocator };
    }

    fn deinit(self: *ChatEventRows) void {
        for (self.rows.items) |row| {
            if (row.event.len > 0) self.allocator.free(row.event);
        }
        self.rows.deinit(self.allocator);
    }

    fn collect(context: *anyopaque, bytes: []const u8) void {
        const self: *ChatEventRows = @ptrCast(@alignCast(context));
        self.appendPage(bytes) catch {
            self.failed = true;
        };
    }

    fn appendPage(self: *ChatEventRows, bytes: []const u8) !void {
        var at: usize = 0;
        const column_count = try readU32(bytes, &at);
        const row_count = try readU32(bytes, &at);
        var names: [16][]const u8 = undefined;
        if (column_count > names.len) return error.TooManyColumns;
        for (0..column_count) |index| {
            names[index] = try readBytes(bytes, &at);
        }
        for (0..row_count) |_| {
            var row: Row = .{};
            errdefer {
                if (row.event.len > 0) self.allocator.free(row.event);
            }
            for (0..column_count) |index| {
                const cell = try readCell(bytes, &at);
                const name = names[index];
                if (std.mem.eql(u8, name, "conversation_id")) {
                    row.conversation_id = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "seq")) {
                    row.seq = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "event")) {
                    row.event = try dupeCell(self.allocator, cell);
                }
            }
            try self.rows.append(self.allocator, row);
        }
    }
};

const CountRows = struct {
    value: i64 = 0,
    found: bool = false,
    failed: bool = false,

    fn collect(context: *anyopaque, bytes: []const u8) void {
        const self: *CountRows = @ptrCast(@alignCast(context));
        self.appendPage(bytes) catch {
            self.failed = true;
        };
    }

    fn appendPage(self: *CountRows, bytes: []const u8) !void {
        var at: usize = 0;
        const column_count = try readU32(bytes, &at);
        const row_count = try readU32(bytes, &at);
        var names: [16][]const u8 = undefined;
        if (column_count > names.len) return error.TooManyColumns;
        for (0..column_count) |index| {
            names[index] = try readBytes(bytes, &at);
        }
        for (0..row_count) |_| {
            var row_value: i64 = 0;
            for (0..column_count) |index| {
                const cell = try readCell(bytes, &at);
                if (std.mem.eql(u8, names[index], "n")) {
                    row_value = cellInteger(cell);
                }
            }
            self.value = row_value;
            self.found = true;
        }
    }
};

const DataCountRows = struct {
    entries: i64 = 0,
    conversations: i64 = 0,
    embeddings: i64 = 0,
    memories: i64 = 0,
    found: bool = false,
    failed: bool = false,

    fn collect(context: *anyopaque, bytes: []const u8) void {
        const self: *DataCountRows = @ptrCast(@alignCast(context));
        self.appendPage(bytes) catch {
            self.failed = true;
        };
    }

    fn appendPage(self: *DataCountRows, bytes: []const u8) !void {
        var at: usize = 0;
        const column_count = try readU32(bytes, &at);
        const row_count = try readU32(bytes, &at);
        var names: [16][]const u8 = undefined;
        if (column_count > names.len) return error.TooManyColumns;
        for (0..column_count) |index| {
            names[index] = try readBytes(bytes, &at);
        }
        for (0..row_count) |_| {
            var seen: u8 = 0;
            for (0..column_count) |index| {
                const value = cellInteger(try readCell(bytes, &at));
                const name = names[index];
                if (std.mem.eql(u8, name, "entries")) {
                    self.entries = value;
                    seen |= 1 << 0;
                } else if (std.mem.eql(u8, name, "conversations")) {
                    self.conversations = value;
                    seen |= 1 << 1;
                } else if (std.mem.eql(u8, name, "embeddings")) {
                    self.embeddings = value;
                    seen |= 1 << 2;
                } else if (std.mem.eql(u8, name, "memories")) {
                    self.memories = value;
                    seen |= 1 << 3;
                }
            }
            if (seen != 0b1111) return error.MissingCountColumn;
            self.found = true;
        }
    }
};

const BlobSliceRows = struct {
    allocator: std.mem.Allocator,
    bytes: []u8 = &.{},
    failed: bool = false,

    fn init(allocator: std.mem.Allocator) BlobSliceRows {
        return .{ .allocator = allocator };
    }

    fn deinit(self: *BlobSliceRows) void {
        if (self.bytes.len > 0) self.allocator.free(self.bytes);
    }

    fn collect(context: *anyopaque, bytes: []const u8) void {
        const self: *BlobSliceRows = @ptrCast(@alignCast(context));
        self.appendPage(bytes) catch {
            self.failed = true;
        };
    }

    fn appendPage(self: *BlobSliceRows, bytes: []const u8) !void {
        var at: usize = 0;
        const column_count = try readU32(bytes, &at);
        const row_count = try readU32(bytes, &at);
        var names: [16][]const u8 = undefined;
        if (column_count > names.len) return error.TooManyColumns;
        for (0..column_count) |index| {
            names[index] = try readBytes(bytes, &at);
        }
        for (0..row_count) |_| {
            var chunk: []u8 = &.{};
            errdefer if (chunk.len > 0) self.allocator.free(chunk);
            for (0..column_count) |index| {
                const cell = try readCell(bytes, &at);
                if (std.mem.eql(u8, names[index], "chunk")) {
                    if (chunk.len > 0) self.allocator.free(chunk);
                    chunk = try dupeCell(self.allocator, cell);
                }
            }
            if (self.bytes.len > 0) self.allocator.free(self.bytes);
            self.bytes = chunk;
        }
    }
};

fn dupeCell(allocator: std.mem.Allocator, cell: Cell) ![]u8 {
    return switch (cell) {
        .text, .blob => |bytes| try allocator.dupe(u8, bytes),
        else => try allocator.dupe(u8, ""),
    };
}

fn writeEntryMeta(writer: *std.Io.Writer, row: QueryRows.Row, excerpt: ?[]const u8) !void {
    try writer.writeAll("{\"id\":");
    try writer.print("{d}", .{row.id});
    try writer.writeAll(",\"date\":");
    try writeJsonString(writer, row.date);
    try writer.writeAll(",\"title\":");
    try writeJsonString(writer, row.title);
    try writer.writeAll(",\"wordCount\":");
    try writer.print("{d}", .{row.word_count});
    try writer.writeAll(",\"format\":");
    try writeJsonString(writer, row.format);
    try writer.writeAll(",\"updatedAt\":");
    try writeJsonString(writer, row.updated_at);
    if (excerpt) |text| {
        try writer.writeAll(",\"excerpt\":");
        try writeJsonString(writer, text);
    }
    try writer.writeByte('}');
}

pub fn writeJsonString(writer: *std.Io.Writer, value: []const u8) !void {
    var scratch: [32768]u8 = undefined;
    const quoted = native_sdk.bridge.writeJsonStringValue(&scratch, value);
    if (quoted.len == 0) return error.TooLarge;
    try writer.writeAll(quoted);
}

fn writeMemorySource(writer: *std.Io.Writer, source_type: []const u8, source_id: i64) !void {
    try writer.writeAll(",\"sourceType\":");
    try writeJsonStringStreaming(writer, source_type);
    try writer.writeAll(",\"sourceId\":");
    try writer.print("{d}", .{source_id});
}

pub fn writeJsonStringStreaming(writer: *std.Io.Writer, value: []const u8) !void {
    try writer.writeByte('"');
    for (value) |byte| {
        switch (byte) {
            '"' => try writer.writeAll("\\\""),
            '\\' => try writer.writeAll("\\\\"),
            '\n' => try writer.writeAll("\\n"),
            '\r' => try writer.writeAll("\\r"),
            '\t' => try writer.writeAll("\\t"),
            else => {
                if (byte < 0x20) {
                    try writer.print("\\u{x:0>4}", .{byte});
                } else {
                    try writer.writeByte(byte);
                }
            },
        }
    }
    try writer.writeByte('"');
}

pub fn utf8Chunk(bytes: []const u8, offset: usize, max_len: usize) []const u8 {
    if (offset >= bytes.len) return &.{};
    const start = offset;
    var end = @min(bytes.len, start + max_len);
    if (end < bytes.len) {
        while (end > start and (bytes[end] & 0xC0) == 0x80) end -= 1;
    }
    return bytes[start..end];
}

const excerpt_window: usize = 120;
const home_latest_snippet_window: usize = 480;
const excerpt_ellipsis = "…";

const HomeSnippetMode = enum { collapse, keep_breaks };

const HomeLatest = struct {
    id: i64,
    title: []const u8,
    date: []const u8,
    word_count: i64,
    format: []const u8,
    snippet: []const u8,
    updated_at: []const u8,
};

const HomeFeedItem = struct {
    kind: enum { conversation, entry },
    id: i64,
    title: []const u8,
    date: []const u8,
    snippet: []const u8,
    sort_at: []const u8,

    fn newerFirst(_: void, first: HomeFeedItem, second: HomeFeedItem) bool {
        return switch (std.mem.order(u8, first.sort_at, second.sort_at)) {
            .gt => true,
            .lt => false,
            .eq => first.id > second.id,
        };
    }
};

fn likeContainsPattern(query: []const u8, buf: []u8) ![]const u8 {
    if (buf.len < 2) return error.TooLarge;
    var at: usize = 0;
    buf[at] = '%';
    at += 1;
    for (query) |ch| {
        const escaped = ch == '\\' or ch == '%' or ch == '_';
        if (at + @as(usize, if (escaped) 2 else 1) >= buf.len) return error.TooLarge;
        if (escaped) {
            buf[at] = '\\';
            at += 1;
        }
        buf[at] = ch;
        at += 1;
    }
    buf[at] = '%';
    at += 1;
    return buf[0..at];
}

fn utf8AlignStart(bytes: []const u8, offset: usize) usize {
    if (offset == 0 or offset >= bytes.len) return @min(offset, bytes.len);
    var at = offset;
    while (at > 0 and (bytes[at] & 0xC0) == 0x80) at -= 1;
    return at;
}

fn utf8AlignEnd(bytes: []const u8, start: usize, offset: usize) usize {
    if (offset >= bytes.len) return bytes.len;
    var at = offset;
    while (at > start and (bytes[at] & 0xC0) == 0x80) at -= 1;
    return at;
}

fn writeExcerptWindow(text: []const u8, start: usize, end: usize, buf: []u8) []const u8 {
    const prefix = start > 0;
    const suffix = end < text.len;
    var at: usize = 0;
    if (prefix and excerpt_ellipsis.len <= buf.len) {
        @memcpy(buf[0..excerpt_ellipsis.len], excerpt_ellipsis);
        at = excerpt_ellipsis.len;
    }
    const take = @min(text[start..end].len, buf.len - at);
    @memcpy(buf[at .. at + take], text[start .. start + take]);
    at += take;
    if (suffix and at + excerpt_ellipsis.len <= buf.len) {
        @memcpy(buf[at .. at + excerpt_ellipsis.len], excerpt_ellipsis);
        at += excerpt_ellipsis.len;
    }
    return buf[0..at];
}

fn excerptAroundMatch(text: []const u8, query: []const u8, buf: []u8) ?[]const u8 {
    if (buf.len == 0) return "";
    const at = std.ascii.indexOfIgnoreCase(text, query) orelse return null;
    const extra = excerpt_window -| query.len;
    const before = extra / 2;
    var start = utf8AlignStart(text, at -| before);
    var end = @min(text.len, start + excerpt_window);
    if (end - start < excerpt_window) {
        start = utf8AlignStart(text, end -| excerpt_window);
    }
    end = utf8AlignEnd(text, start, end);
    return writeExcerptWindow(text, start, end, buf);
}

fn excerptLead(text: []const u8, buf: []u8) []const u8 {
    return excerptLeadN(text, buf, excerpt_window);
}

fn excerptLeadN(text: []const u8, buf: []u8, window: usize) []const u8 {
    if (text.len == 0 or buf.len == 0) return "";
    const end = utf8AlignEnd(text, 0, @min(text.len, window));
    return writeExcerptWindow(text, 0, end, buf);
}

fn isCalendarDate(value: []const u8) bool {
    if (value.len != 10) return false;
    for (value, 0..) |ch, index| {
        if (index == 4 or index == 7) {
            if (ch != '-') return false;
        } else if (ch < '0' or ch > '9') {
            return false;
        }
    }
    return true;
}

fn calendarDatePrefix(value: []const u8) []const u8 {
    if (value.len >= 10) return value[0..10];
    return value;
}

fn homeEntrySortAt(allocator: std.mem.Allocator, date: []const u8) ![]u8 {
    return std.fmt.allocPrint(allocator, "{s}T00:00:00.000Z", .{date});
}

fn collapseWs(allocator: std.mem.Allocator, text: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    var pending_space = false;
    for (text) |ch| {
        const ws = ch == ' ' or ch == '\t' or ch == '\n' or ch == '\r';
        if (ws) {
            if (out.items.len == 0) continue;
            pending_space = true;
            continue;
        }
        if (pending_space) {
            try out.append(allocator, ' ');
            pending_space = false;
        }
        try out.append(allocator, ch);
    }
    return out.toOwnedSlice(allocator);
}

fn homeLead(allocator: std.mem.Allocator, text: []const u8, window: usize) ![]u8 {
    var buf: [512]u8 = undefined;
    const take = excerptLeadN(text, &buf, window);
    return allocator.dupe(u8, take);
}

fn homeSnippet(allocator: std.mem.Allocator, text: []const u8, window: usize) ![]u8 {
    const collapsed = try collapseWs(allocator, text);
    defer allocator.free(collapsed);
    return homeLead(allocator, collapsed, window);
}

fn writeHomeLatest(writer: *std.Io.Writer, row: HomeLatest) !void {
    try writer.writeAll("{\"id\":");
    try writer.print("{d}", .{row.id});
    try writer.writeAll(",\"title\":");
    try writeJsonStringStreaming(writer, row.title);
    try writer.writeAll(",\"date\":");
    try writeJsonStringStreaming(writer, row.date);
    try writer.writeAll(",\"wordCount\":");
    try writer.print("{d}", .{row.word_count});
    try writer.writeAll(",\"format\":");
    try writeJsonStringStreaming(writer, row.format);
    try writer.writeAll(",\"updatedAt\":");
    try writeJsonStringStreaming(writer, row.updated_at);
    try writer.writeAll(",\"snippet\":");
    try writeJsonStringStreaming(writer, row.snippet);
    try writer.writeByte('}');
}

fn writeHomeItem(writer: *std.Io.Writer, item: HomeFeedItem) !void {
    try writer.writeAll("{\"kind\":");
    try writeJsonStringStreaming(writer, switch (item.kind) {
        .entry => "entry",
        .conversation => "conversation",
    });
    try writer.writeAll(",\"id\":");
    try writer.print("{d}", .{item.id});
    try writer.writeAll(",\"title\":");
    try writeJsonStringStreaming(writer, item.title);
    try writer.writeAll(",\"date\":");
    try writeJsonStringStreaming(writer, item.date);
    try writer.writeAll(",\"snippet\":");
    try writeJsonStringStreaming(writer, item.snippet);
    try writer.writeByte('}');
}

fn excerptFor(title: []const u8, body: []const u8, query: []const u8, buf: []u8) []const u8 {
    if (excerptAroundMatch(title, query, buf)) |text| return text;
    if (excerptAroundMatch(body, query, buf)) |text| return text;
    if (body.len > 0) return excerptLead(body, buf);
    return excerptLead(title, buf);
}

/// Collects (key, value) text rows from an `app_setting` query page. Shared
/// by lock.zig and vault.zig, which both keep their state in that table.
pub const KvRows = struct {
    allocator: std.mem.Allocator,
    rows: std.ArrayList(Row) = .empty,
    failed: bool = false,

    pub const Row = struct {
        key: []u8 = &.{},
        value: []u8 = &.{},
    };

    pub fn init(allocator: std.mem.Allocator) KvRows {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *KvRows) void {
        for (self.rows.items) |row| {
            if (row.key.len > 0) self.allocator.free(row.key);
            if (row.value.len > 0) self.allocator.free(row.value);
        }
        self.rows.deinit(self.allocator);
    }

    pub fn collect(context: *anyopaque, bytes: []const u8) void {
        const self: *KvRows = @ptrCast(@alignCast(context));
        self.appendPage(bytes) catch {
            self.failed = true;
        };
    }

    fn appendPage(self: *KvRows, bytes: []const u8) !void {
        var at: usize = 0;
        const column_count = try readU32(bytes, &at);
        const row_count = try readU32(bytes, &at);
        var names: [8][]const u8 = undefined;
        if (column_count > names.len) return error.TooManyColumns;
        for (0..column_count) |index| {
            names[index] = try readBytes(bytes, &at);
        }
        for (0..row_count) |_| {
            var row: Row = .{};
            errdefer {
                if (row.key.len > 0) self.allocator.free(row.key);
                if (row.value.len > 0) self.allocator.free(row.value);
            }
            for (0..column_count) |index| {
                const cell = try readCell(bytes, &at);
                const text = switch (cell) {
                    .text, .blob => |cell_bytes| try self.allocator.dupe(u8, cell_bytes),
                    else => try self.allocator.dupe(u8, ""),
                };
                if (std.mem.eql(u8, names[index], "key")) {
                    row.key = text;
                } else if (std.mem.eql(u8, names[index], "value")) {
                    row.value = text;
                } else {
                    self.allocator.free(text);
                }
            }
            try self.rows.append(self.allocator, row);
        }
    }
};

const QueryRows = struct {
    allocator: std.mem.Allocator,
    rows: std.ArrayList(Row) = .empty,
    failed: bool = false,

    const Row = struct {
        id: i64 = 0,
        date: []u8 = &.{},
        title: []u8 = &.{},
        body: []u8 = &.{},
        word_count: i64 = 0,
        format: []u8 = &.{},
        updated_at: []u8 = &.{},
    };

    fn init(allocator: std.mem.Allocator) QueryRows {
        return .{ .allocator = allocator };
    }

    fn deinit(self: *QueryRows) void {
        for (self.rows.items) |row| {
            if (row.date.len > 0) self.allocator.free(row.date);
            if (row.title.len > 0) self.allocator.free(row.title);
            if (row.body.len > 0) self.allocator.free(row.body);
            if (row.format.len > 0) self.allocator.free(row.format);
            if (row.updated_at.len > 0) self.allocator.free(row.updated_at);
        }
        self.rows.deinit(self.allocator);
    }

    fn collect(context: *anyopaque, bytes: []const u8) void {
        const self: *QueryRows = @ptrCast(@alignCast(context));
        self.appendPage(bytes) catch {
            self.failed = true;
        };
    }

    fn appendPage(self: *QueryRows, bytes: []const u8) !void {
        var at: usize = 0;
        const column_count = try readU32(bytes, &at);
        const row_count = try readU32(bytes, &at);
        var names: [16][]const u8 = undefined;
        if (column_count > names.len) return error.TooManyColumns;
        for (0..column_count) |index| {
            names[index] = try readBytes(bytes, &at);
        }
        for (0..row_count) |_| {
            var row: Row = .{};
            errdefer {
                if (row.date.len > 0) self.allocator.free(row.date);
                if (row.title.len > 0) self.allocator.free(row.title);
                if (row.body.len > 0) self.allocator.free(row.body);
                if (row.format.len > 0) self.allocator.free(row.format);
                if (row.updated_at.len > 0) self.allocator.free(row.updated_at);
            }
            for (0..column_count) |index| {
                const cell = try readCell(bytes, &at);
                const name = names[index];
                if (std.mem.eql(u8, name, "id")) {
                    row.id = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "entry_date")) {
                    row.date = try self.dupeText(cell);
                } else if (std.mem.eql(u8, name, "title")) {
                    row.title = try self.dupeText(cell);
                } else if (std.mem.eql(u8, name, "body")) {
                    row.body = try self.dupeText(cell);
                } else if (std.mem.eql(u8, name, "word_count")) {
                    row.word_count = cellInteger(cell);
                } else if (std.mem.eql(u8, name, "body_format")) {
                    row.format = try self.dupeText(cell);
                } else if (std.mem.eql(u8, name, "updated_at")) {
                    row.updated_at = try self.dupeText(cell);
                }
            }
            if (row.format.len == 0) row.format = try self.allocator.dupe(u8, "plain");
            try self.rows.append(self.allocator, row);
        }
    }

    fn dupeText(self: *QueryRows, cell: Cell) ![]u8 {
        return switch (cell) {
            .text, .blob => |bytes| try self.allocator.dupe(u8, bytes),
            else => try self.allocator.dupe(u8, ""),
        };
    }
};

pub const Cell = union(enum) {
    null,
    integer: i64,
    real: f64,
    text: []const u8,
    blob: []const u8,
};

fn cellInteger(cell: Cell) i64 {
    return switch (cell) {
        .integer => |value| value,
        .real => |value| @intFromFloat(value),
        .text => |bytes| std.fmt.parseInt(i64, bytes, 10) catch 0,
        else => 0,
    };
}

fn cellOptionalInteger(cell: Cell) ?i64 {
    return switch (cell) {
        .integer => |value| value,
        .real => |value| @intFromFloat(value),
        .text => |bytes| std.fmt.parseInt(i64, bytes, 10) catch null,
        else => null,
    };
}

pub fn readU32(bytes: []const u8, at: *usize) !u32 {
    if (at.* + 4 > bytes.len) return error.CorruptPage;
    const value = std.mem.readInt(u32, bytes[at.*..][0..4], .little);
    at.* += 4;
    return value;
}

pub fn readBytes(bytes: []const u8, at: *usize) ![]const u8 {
    const len = try readU32(bytes, at);
    if (at.* + len > bytes.len) return error.CorruptPage;
    const slice = bytes[at.* .. at.* + len];
    at.* += len;
    return slice;
}

pub fn readCell(bytes: []const u8, at: *usize) !Cell {
    if (at.* >= bytes.len) return error.CorruptPage;
    const tag = bytes[at.*];
    at.* += 1;
    return switch (tag) {
        0 => .null,
        1 => blk: {
            if (at.* + 8 > bytes.len) return error.CorruptPage;
            const value = std.mem.readInt(i64, bytes[at.*..][0..8], .little);
            at.* += 8;
            break :blk .{ .integer = value };
        },
        2 => blk: {
            if (at.* + 8 > bytes.len) return error.CorruptPage;
            const value: f64 = @bitCast(std.mem.readInt(u64, bytes[at.*..][0..8], .little));
            at.* += 8;
            break :blk .{ .real = value };
        },
        3 => .{ .text = try readBytes(bytes, at) },
        4 => .{ .blob = try readBytes(bytes, at) },
        else => error.CorruptPage,
    };
}

fn jsonRaw(payload: []const u8, field: []const u8) ?[]const u8 {
    var index: usize = 0;
    skipWs(payload, &index);
    if (index >= payload.len or payload[index] != '{') return null;
    index += 1;
    while (index < payload.len) {
        skipWs(payload, &index);
        if (index < payload.len and payload[index] == '}') return null;
        const key = parseJsonStringSpan(payload, &index) orelse return null;
        skipWs(payload, &index);
        if (index >= payload.len or payload[index] != ':') return null;
        index += 1;
        skipWs(payload, &index);
        const start = index;
        skipJsonValue(payload, &index) orelse return null;
        const value = payload[start..index];
        if (std.mem.eql(u8, key, field)) return value;
        skipWs(payload, &index);
        if (index < payload.len and payload[index] == ',') {
            index += 1;
            continue;
        }
        return null;
    }
    return null;
}

fn jsonIsNull(payload: []const u8, field: []const u8) bool {
    const raw = jsonRaw(payload, field) orelse return false;
    return std.mem.eql(u8, raw, "null");
}

pub fn jsonBool(payload: []const u8, field: []const u8) ?bool {
    const raw = jsonRaw(payload, field) orelse return null;
    if (std.mem.eql(u8, raw, "true")) return true;
    if (std.mem.eql(u8, raw, "false")) return false;
    return null;
}

/// Extract an integer field from a flat JSON object payload. Shared with
/// main.zig's bridge handlers.
pub fn jsonI64(payload: []const u8, field: []const u8) ?i64 {
    const raw = jsonRaw(payload, field) orelse return null;
    return std.fmt.parseInt(i64, raw, 10) catch null;
}

pub fn jsonString(payload: []const u8, field: []const u8, buf: []u8, used: *usize) ?[]const u8 {
    const raw = jsonRaw(payload, field) orelse return null;
    const rest = buf[used.*..];
    const decoded = unescapeJsonString(raw, rest) orelse return null;
    used.* += decoded.len;
    return decoded;
}

/// Extract a JSON array of finite floats. Missing field: `null`. Present but
/// not a float array: `error.InvalidRequest`. Caller owns a non-null slice.
pub fn jsonF32Array(payload: []const u8, field: []const u8, allocator: std.mem.Allocator) !?[]f32 {
    const raw = jsonRaw(payload, field) orelse return null;
    const trimmed = std.mem.trim(u8, raw, " \t\n\r");
    if (trimmed.len < 2 or trimmed[0] != '[' or trimmed[trimmed.len - 1] != ']')
        return error.InvalidRequest;

    var values: std.ArrayList(f32) = .empty;
    errdefer values.deinit(allocator);

    var index: usize = 1;
    skipWs(trimmed, &index);
    if (index < trimmed.len and trimmed[index] == ']') {
        return try values.toOwnedSlice(allocator);
    }

    while (index < trimmed.len) {
        skipWs(trimmed, &index);
        if (index >= trimmed.len) return error.InvalidRequest;
        const start = index;
        while (index < trimmed.len) : (index += 1) {
            switch (trimmed[index]) {
                ',', ']', ' ', '\n', '\r', '\t' => break,
                else => {},
            }
        }
        if (start == index) return error.InvalidRequest;
        const value = std.fmt.parseFloat(f32, trimmed[start..index]) catch return error.InvalidRequest;
        if (!std.math.isFinite(value)) return error.InvalidRequest;
        try values.append(allocator, value);
        skipWs(trimmed, &index);
        if (index >= trimmed.len) return error.InvalidRequest;
        if (trimmed[index] == ']') break;
        if (trimmed[index] != ',') return error.InvalidRequest;
        index += 1;
    }

    return try values.toOwnedSlice(allocator);
}

fn unescapeJsonString(raw: []const u8, out: []u8) ?[]const u8 {
    if (raw.len < 2 or raw[0] != '"' or raw[raw.len - 1] != '"') return null;
    var index: usize = 1;
    var at: usize = 0;
    while (index < raw.len - 1) {
        const ch = raw[index];
        if (ch == '\\') {
            index += 1;
            if (index >= raw.len - 1) return null;
            const esc = raw[index];
            index += 1;
            if (esc == 'u') {
                const first = parseHex4(raw, &index) orelse return null;
                const codepoint = decodeJsonCodepoint(raw, &index, first) orelse return null;
                at = appendUtf8(out, at, codepoint) orelse return null;
                continue;
            }
            if (at >= out.len) return null;
            out[at] = switch (esc) {
                '"' => '"',
                '\\' => '\\',
                '/' => '/',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                'b' => 0x08,
                'f' => 0x0c,
                else => return null,
            };
            at += 1;
            continue;
        }
        if (ch == '"' or ch <= 0x1f) return null;
        if (at >= out.len) return null;
        out[at] = ch;
        at += 1;
        index += 1;
    }
    return out[0..at];
}

fn parseHex4(raw: []const u8, index: *usize) ?u16 {
    if (index.* + 4 >= raw.len) return null;
    const value = std.fmt.parseInt(u16, raw[index.* .. index.* + 4], 16) catch return null;
    index.* += 4;
    return value;
}

fn decodeJsonCodepoint(raw: []const u8, index: *usize, first: u16) ?u21 {
    if (first >= 0xD800 and first <= 0xDBFF) {
        if (index.* + 6 >= raw.len) return null;
        if (raw[index.*] != '\\' or raw[index.* + 1] != 'u') return null;
        index.* += 2;
        const low = parseHex4(raw, index) orelse return null;
        if (low < 0xDC00 or low > 0xDFFF) return null;
        const high: u21 = first;
        const low_cp: u21 = low;
        return 0x10000 + ((high - 0xD800) << 10) + (low_cp - 0xDC00);
    }
    if (first >= 0xDC00 and first <= 0xDFFF) return null;
    return first;
}

fn appendUtf8(out: []u8, at: usize, codepoint: u21) ?usize {
    var utf8: [4]u8 = undefined;
    const n = std.unicode.utf8Encode(codepoint, &utf8) catch return null;
    if (at + n > out.len) return null;
    @memcpy(out[at .. at + n], utf8[0..n]);
    return at + n;
}

fn parseJsonStringSpan(payload: []const u8, index: *usize) ?[]const u8 {
    if (index.* >= payload.len or payload[index.*] != '"') return null;
    index.* += 1;
    const start = index.*;
    while (index.* < payload.len) {
        const ch = payload[index.*];
        if (ch == '"') {
            const value = payload[start..index.*];
            index.* += 1;
            return value;
        }
        if (ch == '\\') {
            index.* += 2;
            continue;
        }
        if (ch <= 0x1f) return null;
        index.* += 1;
    }
    return null;
}

fn skipJsonValue(payload: []const u8, index: *usize) ?void {
    if (index.* >= payload.len) return null;
    switch (payload[index.*]) {
        '"' => {
            _ = parseJsonStringSpan(payload, index) orelse return null;
        },
        '{' => skipBalanced(payload, index, '{', '}') orelse return null,
        '[' => skipBalanced(payload, index, '[', ']') orelse return null,
        else => {
            while (index.* < payload.len) : (index.* += 1) {
                switch (payload[index.*]) {
                    ',', '}', ']', ' ', '\n', '\r', '\t' => break,
                    else => {},
                }
            }
        },
    }
    return {};
}

fn skipBalanced(payload: []const u8, index: *usize, open_ch: u8, close_ch: u8) ?void {
    if (index.* >= payload.len or payload[index.*] != open_ch) return null;
    var depth: usize = 0;
    while (index.* < payload.len) {
        const ch = payload[index.*];
        if (ch == '"') {
            _ = parseJsonStringSpan(payload, index) orelse return null;
            continue;
        }
        if (ch == open_ch) depth += 1;
        if (ch == close_ch) {
            depth -= 1;
            index.* += 1;
            if (depth == 0) return {};
            continue;
        }
        index.* += 1;
    }
    return null;
}

fn skipWs(payload: []const u8, index: *usize) void {
    while (index.* < payload.len) : (index.* += 1) {
        switch (payload[index.*]) {
            ' ', '\n', '\r', '\t' => {},
            else => return,
        }
    }
}

fn chatEventAad(buf: []u8, conversation_id: i64, seq: i64) []u8 {
    return std.fmt.bufPrint(buf, "chat_event:{d}:{d}", .{ conversation_id, seq }) catch unreachable;
}

fn splitJsonArrayElements(allocator: std.mem.Allocator, json: []const u8) ![][]const u8 {
    var index: usize = 0;
    skipWs(json, &index);
    if (index >= json.len or json[index] != '[') return error.InvalidRequest;
    index += 1;
    var items: std.ArrayList([]const u8) = .empty;
    errdefer items.deinit(allocator);
    skipWs(json, &index);
    if (index < json.len and json[index] == ']') return items.toOwnedSlice(allocator);

    while (index < json.len) {
        skipWs(json, &index);
        const start = index;
        skipJsonValue(json, &index) orelse return error.InvalidRequest;
        if (start == index) return error.InvalidRequest;
        try items.append(allocator, json[start..index]);
        skipWs(json, &index);
        if (index < json.len and json[index] == ',') {
            index += 1;
            continue;
        }
        if (index < json.len and json[index] == ']') return items.toOwnedSlice(allocator);
        return error.InvalidRequest;
    }
    return error.InvalidRequest;
}

fn testStore() !Store {
    const open_result = try native_sdk.RelationalStore.openMemoryMigrated(std.testing.allocator, &migrations);
    const db = switch (open_result.outcome) {
        .ok => open_result.database.?,
        else => return error.SqliteMigrationFailed,
    };
    return Store.init(std.testing.allocator, db);
}

fn countSourceRows(store: *Store, sql: []const u8, source: []const u8, id: i64) !i64 {
    var counts = CountRows{};
    const outcome = store.db.query(
        sql,
        &.{ .{ .text = source }, .{ .integer = id } },
        &counts,
        CountRows.collect,
    );
    if (outcome != .ok or counts.failed) return error.SqliteQueryFailed;
    return counts.value;
}

fn countSourceFacts(store: *Store, source: []const u8, id: i64) !i64 {
    return countSourceRows(
        store,
        "SELECT count(*) AS n FROM semantic_fact WHERE source_type = ?1 AND source_id = ?2;",
        source,
        id,
    );
}

fn countSourceEvents(store: *Store, source: []const u8, id: i64) !i64 {
    return countSourceRows(
        store,
        "SELECT count(*) AS n FROM episodic_event WHERE source_type = ?1 AND source_id = ?2;",
        source,
        id,
    );
}

fn countSourceDreamState(store: *Store, source: []const u8, id: i64) !i64 {
    return countSourceRows(
        store,
        "SELECT count(*) AS n FROM dream_state WHERE source_type = ?1 AND source_id = ?2;",
        source,
        id,
    );
}

fn insertDataWipeFixture(store: *Store) !void {
    const outcome = store.db.exec(&.{
        .{ .sql = "INSERT INTO chat_conversation (title, eve_session_id, stream_index, events) VALUES ('Wipe test chat', 'wrun_wipe-test', 0, '[]');", .params = &.{} },
        .{ .sql = "INSERT INTO chat_event (conversation_id, seq, event) VALUES (1, 0, 'transcript event');", .params = &.{} },
        .{ .sql = "INSERT INTO entry_embedding (entry_id, chunk_index, chunk_text, embedding, model) VALUES (1, 0, 'entry chunk', x'01', 'test-model');", .params = &.{} },
        .{ .sql = "INSERT INTO entry_summary (entry_id, summary, embedding, model, embed_model) VALUES (1, 'entry summary', x'02', 'test-model', 'test-embed');", .params = &.{} },
        .{ .sql = "INSERT INTO chat_embedding (conversation_id, chunk_index, chunk_text, embedding, model) VALUES (1, 0, 'chat chunk', x'03', 'test-model');", .params = &.{} },
        .{ .sql = "INSERT INTO chat_summary (conversation_id, summary, embedding, model, embed_model) VALUES (1, 'chat summary', x'04', 'test-model', 'test-embed');", .params = &.{} },
        .{ .sql = "INSERT INTO semantic_fact (kind, subject, fact, embedding, source_type, source_id, model, pinned, hidden, origin_text) VALUES ('fact', 'Entry', 'Dream entry fact', x'05', 'entry', 1, 'test-model', 1, 0, '');", .params = &.{} },
        .{ .sql = "INSERT INTO semantic_fact (kind, subject, fact, embedding, source_type, source_id, model, hidden) VALUES ('fact', 'Hidden entry', 'Hidden entry fact', x'06', 'entry', 1, 'test-model', 1);", .params = &.{} },
        .{ .sql = "INSERT INTO semantic_fact (kind, subject, fact, embedding, source_type, source_id, model) VALUES ('fact', 'Chat', 'Dream chat fact', x'07', 'conversation', 1, 'test-model');", .params = &.{} },
        .{ .sql = "INSERT INTO semantic_fact (kind, subject, fact, embedding, source_type, source_id, model) VALUES ('profile', 'You', 'User profile fact', x'08', 'user', 0, 'test-model');", .params = &.{} },
        .{ .sql = "INSERT INTO episodic_event (event, occurred_at, embedding, source_type, source_id, model) VALUES ('Dream entry event', '2026-09-01', x'09', 'entry', 1, 'test-model');", .params = &.{} },
        .{ .sql = "INSERT INTO episodic_event (event, occurred_at, embedding, source_type, source_id, model, hidden) VALUES ('Hidden chat event', '2026-09-02', x'0a', 'conversation', 1, 'test-model', 1);", .params = &.{} },
        .{ .sql = "INSERT INTO episodic_event (event, occurred_at, embedding, source_type, source_id, model) VALUES ('User event', '2026-09-03', x'0b', 'user', 0, 'test-model');", .params = &.{} },
    });
    if (outcome != .ok) return error.SqliteWriteFailed;
    try store.markDreamed(.entry, 1);
    try store.markDreamed(.conversation, 1);
}

test "dataCounts counts indexes and visible memories" {
    var store = try testStore();
    defer store.deinit();
    try insertDataWipeFixture(&store);

    var output: [256]u8 = undefined;
    try std.testing.expectEqualStrings(
        "{\"entries\":3,\"conversations\":1,\"embeddings\":4,\"memories\":5}",
        try store.dataCounts(&output),
    );
}

test "entry wipe invalidates an active chunked save" {
    var store = try testStore();
    defer store.deinit();

    var output: [256]u8 = undefined;
    _ = try store.save(
        "{\"id\":null,\"title\":\"Pending entry\",\"date\":\"2026-09-01\",\"wordCount\":2,\"format\":\"markdown\",\"offset\":0,\"chunk\":\"partial\",\"done\":false}",
        &output,
    );
    _ = try store.deleteEntries(&output);
    try std.testing.expectError(
        error.InvalidSaveChunk,
        store.save(
            "{\"id\":null,\"title\":\"Pending entry\",\"date\":\"2026-09-01\",\"wordCount\":2,\"format\":\"markdown\",\"offset\":7,\"chunk\":\" body\",\"done\":true}",
            &output,
        ),
    );
    try std.testing.expectEqual(@as(i64, 0), try store.countDataRows("SELECT count(*) AS n FROM journal_entry;"));
}

test "conversation wipe invalidates an active chunked save" {
    var store = try testStore();
    defer store.deinit();

    var output: [256]u8 = undefined;
    _ = try store.chatSave(
        "{\"id\":null,\"title\":\"Pending chat\",\"eveSessionId\":null,\"streamIndex\":0,\"model\":\"llama3.2\",\"thinking\":true,\"contextLength\":8192,\"baseSeq\":0,\"offset\":0,\"chunk\":\"[\",\"done\":false}",
        &output,
    );
    _ = try store.deleteConversations(&output);
    try std.testing.expectError(
        error.InvalidSaveChunk,
        store.chatSave(
            "{\"id\":null,\"title\":\"Pending chat\",\"eveSessionId\":null,\"streamIndex\":0,\"model\":\"llama3.2\",\"thinking\":true,\"contextLength\":8192,\"baseSeq\":0,\"offset\":1,\"chunk\":\"]\",\"done\":true}",
            &output,
        ),
    );
    try std.testing.expectEqual(@as(i64, 0), try store.countDataRows("SELECT count(*) AS n FROM chat_conversation;"));
}

test "embedding wipe leaves an active chat save intact" {
    var store = try testStore();
    defer store.deinit();

    var output: [256]u8 = undefined;
    _ = try store.chatSave(
        "{\"id\":null,\"title\":\"Pending chat\",\"eveSessionId\":null,\"streamIndex\":0,\"model\":\"llama3.2\",\"thinking\":true,\"contextLength\":8192,\"baseSeq\":0,\"offset\":0,\"chunk\":\"[\",\"done\":false}",
        &output,
    );
    _ = try store.deleteEmbeddings(&output);
    const saved = try store.chatSave(
        "{\"id\":null,\"title\":\"Pending chat\",\"eveSessionId\":null,\"streamIndex\":0,\"model\":\"llama3.2\",\"thinking\":true,\"contextLength\":8192,\"baseSeq\":0,\"offset\":1,\"chunk\":\"]\",\"done\":true}",
        &output,
    );
    try std.testing.expect(std.mem.indexOf(u8, saved, "\"id\":1") != null);
    try std.testing.expectEqual(@as(i64, 1), try store.countDataRows("SELECT count(*) AS n FROM chat_conversation;"));
}

test "deleteEntries removes entry data and dreamed memories only" {
    var store = try testStore();
    defer store.deinit();
    try insertDataWipeFixture(&store);

    var output: [256]u8 = undefined;
    try std.testing.expectEqualStrings("{\"ok\":true}", try store.deleteEntries(&output));
    try std.testing.expectEqual(@as(u64, 1), store.data_generation);
    try std.testing.expectEqual(@as(i64, 0), try store.countDataRows("SELECT count(*) AS n FROM journal_entry;"));
    try std.testing.expectEqual(@as(i64, 0), try store.countDataRows("SELECT count(*) AS n FROM entry_embedding;"));
    try std.testing.expectEqual(@as(i64, 0), try store.countDataRows("SELECT count(*) AS n FROM entry_summary;"));
    try std.testing.expectEqual(@as(i64, 0), try countSourceFacts(&store, "entry", 1));
    try std.testing.expectEqual(@as(i64, 0), try countSourceEvents(&store, "entry", 1));
    try std.testing.expectEqual(@as(i64, 1), try countSourceFacts(&store, "user", 0));
    try std.testing.expectEqual(@as(i64, 1), try countSourceEvents(&store, "user", 0));
    try std.testing.expectEqual(@as(i64, 0), try countSourceDreamState(&store, "entry", 1));
    try std.testing.expectEqual(@as(i64, 1), try countSourceDreamState(&store, "conversation", 1));
    try std.testing.expectEqualStrings(
        "{\"entries\":0,\"conversations\":1,\"embeddings\":2,\"memories\":3}",
        try store.dataCounts(&output),
    );
}

test "deleteConversations removes chat data and dreamed memories only" {
    var store = try testStore();
    defer store.deinit();
    try insertDataWipeFixture(&store);

    var output: [256]u8 = undefined;
    try std.testing.expectEqualStrings("{\"ok\":true}", try store.deleteConversations(&output));
    try std.testing.expectEqual(@as(u64, 1), store.data_generation);
    try std.testing.expectEqual(@as(i64, 0), try store.countDataRows("SELECT count(*) AS n FROM chat_conversation;"));
    try std.testing.expectEqual(@as(i64, 0), try store.countDataRows("SELECT count(*) AS n FROM chat_event;"));
    try std.testing.expectEqual(@as(i64, 0), try store.countDataRows("SELECT count(*) AS n FROM chat_embedding;"));
    try std.testing.expectEqual(@as(i64, 0), try store.countDataRows("SELECT count(*) AS n FROM chat_summary;"));
    try std.testing.expectEqual(@as(i64, 0), try countSourceFacts(&store, "conversation", 1));
    try std.testing.expectEqual(@as(i64, 0), try countSourceEvents(&store, "conversation", 1));
    try std.testing.expectEqual(@as(i64, 2), try countSourceFacts(&store, "entry", 1));
    try std.testing.expectEqual(@as(i64, 1), try countSourceFacts(&store, "user", 0));
    try std.testing.expectEqual(@as(i64, 1), try countSourceDreamState(&store, "entry", 1));
    try std.testing.expectEqual(@as(i64, 0), try countSourceDreamState(&store, "conversation", 1));
    try std.testing.expectEqualStrings(
        "{\"entries\":3,\"conversations\":0,\"embeddings\":2,\"memories\":4}",
        try store.dataCounts(&output),
    );
}

test "deleteEmbeddings removes only the four journal and chat indexes" {
    var store = try testStore();
    defer store.deinit();
    try insertDataWipeFixture(&store);

    var output: [256]u8 = undefined;
    try std.testing.expectEqualStrings("{\"ok\":true}", try store.deleteEmbeddings(&output));
    try std.testing.expectEqual(@as(u64, 1), store.data_generation);
    try std.testing.expectEqual(@as(i64, 3), try store.countDataRows("SELECT count(*) AS n FROM journal_entry;"));
    try std.testing.expectEqual(@as(i64, 1), try store.countDataRows("SELECT count(*) AS n FROM chat_conversation;"));
    try std.testing.expectEqual(@as(i64, 1), try store.countDataRows("SELECT count(*) AS n FROM chat_event;"));
    try std.testing.expectEqual(@as(i64, 1), try store.countDataRows("SELECT count(*) AS n FROM semantic_fact WHERE source_type = 'user' AND embedding = x'08';"));
    try std.testing.expectEqual(@as(i64, 1), try countSourceDreamState(&store, "entry", 1));
    try std.testing.expectEqual(@as(i64, 1), try countSourceDreamState(&store, "conversation", 1));
    try std.testing.expectEqualStrings(
        "{\"entries\":3,\"conversations\":1,\"embeddings\":0,\"memories\":5}",
        try store.dataCounts(&output),
    );

    const pending = try store.listPendingDream(true);
    defer store.allocator.free(pending);
    var found_index_only_entry = false;
    for (pending) |item| {
        if (item.source == .entry and item.id == 1) {
            found_index_only_entry = true;
            try std.testing.expect(!item.needs_memory_extraction);
        }
    }
    try std.testing.expect(found_index_only_entry);
    try std.testing.expectEqual(@as(i64, 2), try countSourceFacts(&store, "entry", 1));
}

test "deleteMemories removes user and hidden rows and clears Dream timestamps" {
    var store = try testStore();
    defer store.deinit();
    try insertDataWipeFixture(&store);

    var output: [256]u8 = undefined;
    try std.testing.expectEqualStrings("{\"ok\":true}", try store.deleteMemories(&output));
    try std.testing.expectEqual(@as(u64, 1), store.data_generation);
    try std.testing.expectEqual(@as(i64, 0), try store.countDataRows("SELECT count(*) AS n FROM semantic_fact;"));
    try std.testing.expectEqual(@as(i64, 0), try store.countDataRows("SELECT count(*) AS n FROM episodic_event;"));
    try std.testing.expectEqual(@as(i64, 0), try store.countDataRows("SELECT count(*) AS n FROM dream_state;"));
    try std.testing.expectEqual(@as(i64, 3), try store.countDataRows("SELECT count(*) AS n FROM journal_entry;"));
    try std.testing.expectEqual(@as(i64, 1), try store.countDataRows("SELECT count(*) AS n FROM chat_conversation;"));
    try std.testing.expectEqual(@as(i64, 1), try store.countDataRows("SELECT count(*) AS n FROM entry_embedding;"));
    try std.testing.expectEqual(@as(i64, 1), try store.countDataRows("SELECT count(*) AS n FROM entry_summary;"));
    try std.testing.expectEqual(@as(i64, 1), try store.countDataRows("SELECT count(*) AS n FROM chat_embedding;"));
    try std.testing.expectEqual(@as(i64, 1), try store.countDataRows("SELECT count(*) AS n FROM chat_summary;"));
    try std.testing.expectEqualStrings(
        "{\"entries\":3,\"conversations\":1,\"embeddings\":4,\"memories\":0}",
        try store.dataCounts(&output),
    );
}

test "a new journal has no content of its own, only the samples" {
    var store = try testStore();
    defer store.deinit();
    try std.testing.expect(!(try store.hasUserContent()));
}

test "a saved or imported entry counts as content" {
    var store = try testStore();
    defer store.deinit();
    var output: [8192]u8 = undefined;
    _ = try store.save(
        "{\"id\":null,\"title\":\"Mine\",\"date\":\"2026-09-13\",\"wordCount\":1,\"format\":\"plain\",\"offset\":0,\"chunk\":\"Mine.\",\"done\":true}",
        &output,
    );
    try std.testing.expect(try store.hasUserContent());
}

test "editing a sample entry counts as content" {
    var store = try testStore();
    defer store.deinit();
    var output: [8192]u8 = undefined;
    _ = try store.save(
        "{\"id\":1,\"title\":\"Morning walk, again\",\"date\":\"2026-08-28\",\"wordCount\":1,\"format\":\"plain\",\"offset\":0,\"chunk\":\"Edited.\",\"done\":true}",
        &output,
    );
    try std.testing.expect(try store.hasUserContent());
}

test "a chat counts as content" {
    var store = try testStore();
    defer store.deinit();
    var output: [8192]u8 = undefined;
    _ = try store.chatSave(
        "{\"id\":null,\"title\":\"A chat\",\"eveSessionId\":\"sess-1\",\"streamIndex\":1,\"model\":\"llama3.2\",\"thinking\":false,\"contextLength\":16384,\"baseSeq\":0,\"offset\":0,\"chunk\":\"[{\\\"type\\\":\\\"x\\\"}]\",\"done\":true}",
        &output,
    );
    try std.testing.expect(try store.hasUserContent());
}

test "list returns seeded journal entries" {
    var store = try testStore();
    defer store.deinit();
    var output: [8192]u8 = undefined;
    const json = try store.list(&output);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"id\":1") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Morning walk") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"format\":\"plain\"") != null);
}

test "save and get round-trip a new entry" {
    var store = try testStore();
    defer store.deinit();
    var output: [8192]u8 = undefined;
    const saved = try store.save(
        "{\"id\":null,\"title\":\"New page\",\"date\":\"2026-09-02\",\"wordCount\":3,\"format\":\"tiptap\",\"offset\":0,\"chunk\":\"{\\\"type\\\":\\\"doc\\\"}\",\"done\":true}",
        &output,
    );
    try std.testing.expect(std.mem.indexOf(u8, saved, "\"id\":4") != null);
    try std.testing.expect(std.mem.indexOf(u8, saved, "\"updatedAt\":\"") != null);

    var get_out: [8192]u8 = undefined;
    const loaded = try store.get("{\"id\":4,\"offset\":0}", &get_out);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "New page") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "tiptap") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"updatedAt\":\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"done\":true") != null);
}

test "save overwrites its retained body after completion" {
    var store = try testStore();
    defer store.deinit();

    var output: [8192]u8 = undefined;
    _ = try store.save(
        "{\"id\":null,\"title\":\"New page\",\"date\":\"2026-09-02\",\"wordCount\":1,\"format\":\"plain\",\"offset\":0,\"chunk\":\"secret\",\"done\":false}",
        &output,
    );
    const body_ptr = store.save_body.items.ptr;
    const body_len = store.save_body.items.len;
    try std.testing.expectEqualStrings("secret", store.save_body.items);

    _ = try store.save(
        "{\"id\":null,\"title\":\"New page\",\"date\":\"2026-09-02\",\"wordCount\":1,\"format\":\"plain\",\"offset\":6,\"chunk\":\"\",\"done\":true}",
        &output,
    );

    try std.testing.expect(!store.save_active);
    try std.testing.expectEqual(@as(usize, 0), store.save_body.items.len);
    const zeroes = [_]u8{0} ** 6;
    try std.testing.expectEqualSlices(u8, &zeroes, body_ptr[0..body_len]);
}

test "save rejects a negative chunk offset" {
    var store = try testStore();
    defer store.deinit();
    var output: [256]u8 = undefined;
    try std.testing.expectError(error.InvalidSaveChunk, store.save(
        "{\"id\":null,\"title\":\"New page\",\"date\":\"2026-09-02\",\"wordCount\":3,\"format\":\"tiptap\",\"offset\":-1,\"chunk\":\"x\",\"done\":false}",
        &output,
    ));
}

test "save caps journal bodies at 1 MiB" {
    var store = try testStore();
    defer store.deinit();

    const max_body = try largeJournalBody(std.testing.allocator, max_save_body_bytes);
    defer std.testing.allocator.free(max_body);
    const id = try saveJournalBody(&store, "Maximum", max_body);
    try std.testing.expect(id > 0);

    const oversized = try largeJournalBody(std.testing.allocator, max_save_body_bytes + 1);
    defer std.testing.allocator.free(oversized);
    try std.testing.expectError(error.TooLarge, saveJournalBody(&store, "Too big", oversized));

    var output: [8192]u8 = undefined;
    const listed = try store.list(&output);
    try std.testing.expect(std.mem.indexOf(u8, listed, "Too big") == null);
}

test "delete removes an entry" {
    var store = try testStore();
    defer store.deinit();
    var output: [256]u8 = undefined;
    _ = try store.delete("{\"id\":2}", &output);
    var list_out: [8192]u8 = undefined;
    const json = try store.list(&list_out);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"id\":2") == null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"id\":1") != null);
}

test "deleteAllData wipes entries and chats and leaves settings" {
    var store = try testStore();
    defer store.deinit();
    const insert_chat = store.db.exec(&.{.{
        .sql = "INSERT INTO chat_conversation (title, eve_session_id, stream_index, events) VALUES (?1, NULL, 0, ?2);",
        .params = &.{ .{ .text = "To wipe" }, .{ .text = "[]" } },
    }});
    try std.testing.expect(insert_chat == .ok);
    const insert_setting = store.db.exec(&.{.{
        .sql = "INSERT INTO app_setting (key, value) VALUES (?1, ?2);",
        .params = &.{ .{ .text = "lock.password_hash" }, .{ .text = "keep-me" } },
    }});
    try std.testing.expect(insert_setting == .ok);

    try std.testing.expectEqual(@as(u64, 0), store.data_generation);
    var output: [256]u8 = undefined;
    const wiped = try store.deleteAllData(&output);
    try std.testing.expectEqualStrings("{\"ok\":true}", wiped);
    try std.testing.expectEqual(@as(u64, 1), store.data_generation);

    var list_out: [8192]u8 = undefined;
    try std.testing.expectEqualStrings("{\"entries\":[]}", try store.list(&list_out));
    try std.testing.expectEqualStrings("{\"conversations\":[]}", try store.chatList(&list_out));

    var rows = KvRows.init(std.testing.allocator);
    defer rows.deinit();
    const outcome = store.db.query(
        "SELECT key, value FROM app_setting WHERE key = 'lock.password_hash';",
        &.{},
        &rows,
        KvRows.collect,
    );
    try std.testing.expect(outcome == .ok);
    try std.testing.expectEqual(@as(usize, 1), rows.rows.items.len);
    try std.testing.expectEqualStrings("keep-me", rows.rows.items[0].value);
}

test "builtin agent instructions match the eve prompt file" {
    const contents = try std.Io.Dir.cwd().readFileAlloc(
        std.testing.io,
        "agent/agent/instructions.md",
        std.testing.allocator,
        .limited(64 * 1024),
    );
    defer std.testing.allocator.free(contents);
    try std.testing.expectEqualStrings(contents, builtin_agent_instructions);
}

test "agent instructions get returns the shipped prompt and empty user text" {
    var store = try testStore();
    defer store.deinit();
    var output: [16384]u8 = undefined;
    const json = try store.agentInstructionsGet(&output);
    try std.testing.expect(std.mem.indexOf(u8, json, "You are Sage") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"user\":\"\"") != null);
}

test "agent instructions json for Chat omits the shipped prompt" {
    var store = try testStore();
    defer store.deinit();
    var output: [256]u8 = undefined;
    var writer = std.Io.Writer.fixed(&output);
    try store.writeAgentUserInstructionsJson(&writer);
    try std.testing.expectEqualStrings("{\"user\":\"\"}", writer.buffered());

    var save_out: [256]u8 = undefined;
    _ = try store.agentInstructionsSave("{\"user\":\"Be direct.\"}", &save_out);
    var filled: [256]u8 = undefined;
    writer = std.Io.Writer.fixed(&filled);
    try store.writeAgentUserInstructionsJson(&writer);
    try std.testing.expectEqualStrings("{\"user\":\"Be direct.\"}", writer.buffered());
}

test "agent instructions save round-trips user text" {
    var store = try testStore();
    defer store.deinit();
    var output: [16384]u8 = undefined;
    const saved = try store.agentInstructionsSave("{\"user\":\"Be direct. Keep replies short.\"}", &output);
    try std.testing.expectEqualStrings("{\"ok\":true}", saved);
    const json = try store.agentInstructionsGet(&output);
    try std.testing.expect(std.mem.indexOf(u8, json, "Be direct. Keep replies short.") != null);

    _ = try store.agentInstructionsSave("{\"user\":\"\"}", &output);
    const cleared = try store.agentInstructionsGet(&output);
    try std.testing.expect(std.mem.indexOf(u8, cleared, "\"user\":\"\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, cleared, "Be direct.") == null);
}

test "agent instructions save rejects text over 8 KiB" {
    var store = try testStore();
    defer store.deinit();
    var user: [agent_user_instruction_max_bytes + 1]u8 = undefined;
    @memset(&user, 'a');
    var payload: [agent_user_instruction_max_bytes + 64]u8 = undefined;
    const json = std.fmt.bufPrint(&payload, "{{\"user\":\"{s}\"}}", .{user}) catch unreachable;
    var output: [256]u8 = undefined;
    try std.testing.expectError(error.TooLarge, store.agentInstructionsSave(json, &output));
}

test "deleteAllData keeps agent instructions" {
    var store = try testStore();
    defer store.deinit();
    var output: [16384]u8 = undefined;
    _ = try store.agentInstructionsSave("{\"user\":\"Stay after wipe.\"}", &output);
    _ = try store.deleteAllData(&output);
    const json = try store.agentInstructionsGet(&output);
    try std.testing.expect(std.mem.indexOf(u8, json, "Stay after wipe.") != null);
}

test "search matches a body phrase and returns an excerpt" {
    var store = try testStore();
    defer store.deinit();
    var output: [8192]u8 = undefined;
    const json = try store.search("{\"query\":\"fog\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"id\":1") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Morning walk") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "fog") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"id\":2") == null);
}

test "search matches a title and body phrase" {
    var store = try testStore();
    defer store.deinit();
    var output: [8192]u8 = undefined;
    const json = try store.search("{\"query\":\"Sage\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"id\":2") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "On building Sage") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"excerpt\":\"On building Sage\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"id\":1") == null);
}

test "search excerpt uses the title when the query is only in the title" {
    var store = try testStore();
    defer store.deinit();
    var save_out: [8192]u8 = undefined;
    _ = try store.save(
        "{\"id\":null,\"title\":\"Zebra title\",\"date\":\"2026-09-05\",\"wordCount\":4,\"format\":\"plain\",\"offset\":0,\"chunk\":\"No overlap in the body.\",\"done\":true}",
        &save_out,
    );
    var output: [8192]u8 = undefined;
    const json = try store.search("{\"query\":\"Zebra\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "Zebra title") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"excerpt\":\"Zebra title\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "No overlap") == null);
}

test "search escapes LIKE wildcards" {
    var store = try testStore();
    defer store.deinit();
    var output: [8192]u8 = undefined;
    const json = try store.search("{\"query\":\"%\"}", &output);
    try std.testing.expectEqualStrings("{\"entries\":[]}", json);
}

test "search returns no rows for a miss" {
    var store = try testStore();
    defer store.deinit();
    var output: [8192]u8 = undefined;
    const json = try store.search("{\"query\":\"zzz\"}", &output);
    try std.testing.expectEqualStrings("{\"entries\":[]}", json);
}

test "search returns no rows for an empty query" {
    var store = try testStore();
    defer store.deinit();
    var output: [256]u8 = undefined;
    const json = try store.search("{\"query\":\"\"}", &output);
    try std.testing.expectEqualStrings("{\"entries\":[]}", json);
}

test "jsonF32Array reads a missing field as null" {
    try std.testing.expect(try jsonF32Array("{\"query\":\"fog\"}", "embedding", std.testing.allocator) == null);
}

test "jsonF32Array reads an empty array" {
    const vec = (try jsonF32Array("{\"embedding\":[]}", "embedding", std.testing.allocator)) orelse
        return error.TestUnexpectedResult;
    defer std.testing.allocator.free(vec);
    try std.testing.expectEqual(@as(usize, 0), vec.len);
}

test "jsonF32Array reads finite floats" {
    const vec = (try jsonF32Array("{\"embedding\":[0.25,-1.5,2]}", "embedding", std.testing.allocator)) orelse
        return error.TestUnexpectedResult;
    defer std.testing.allocator.free(vec);
    try std.testing.expectEqual(@as(usize, 3), vec.len);
    try std.testing.expectEqual(@as(f32, 0.25), vec[0]);
    try std.testing.expectEqual(@as(f32, -1.5), vec[1]);
    try std.testing.expectEqual(@as(f32, 2), vec[2]);
}

test "jsonF32Array rejects a non-array field" {
    try std.testing.expectError(
        error.InvalidRequest,
        jsonF32Array("{\"embedding\":\"nope\"}", "embedding", std.testing.allocator),
    );
}

test "jsonF32Array rejects non-finite values" {
    try std.testing.expectError(
        error.InvalidRequest,
        jsonF32Array("{\"embedding\":[nan]}", "embedding", std.testing.allocator),
    );
    try std.testing.expectError(
        error.InvalidRequest,
        jsonF32Array("{\"embedding\":[inf]}", "embedding", std.testing.allocator),
    );
    try std.testing.expectError(
        error.InvalidRequest,
        jsonF32Array("{\"embedding\":[-inf]}", "embedding", std.testing.allocator),
    );
    try std.testing.expectError(
        error.InvalidRequest,
        jsonF32Array("{\"embedding\":[1e999]}", "embedding", std.testing.allocator),
    );
}

test "unescapeJsonString decodes unicode escapes and surrogate pairs" {
    var buf: [32]u8 = undefined;
    const vertical_tab = unescapeJsonString("\"A\\u000bB\"", &buf) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqualStrings("A\x0bB", vertical_tab);
    const memo = unescapeJsonString("\"\\uD83D\\uDCDD\"", &buf) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqualStrings("📝", memo);
}

test "save accepts a unicode escape in the title" {
    var store = try testStore();
    defer store.deinit();
    var output: [8192]u8 = undefined;
    const saved = try store.save(
        "{\"id\":null,\"title\":\"A\\u000bB\",\"date\":\"2026-09-02\",\"wordCount\":1,\"format\":\"plain\",\"offset\":0,\"chunk\":\"hi\",\"done\":true}",
        &output,
    );
    try std.testing.expect(std.mem.indexOf(u8, saved, "\"id\":4") != null);
}

test "loadBody returns body and format for an entry" {
    var store = try testStore();
    defer store.deinit();
    const loaded = try store.loadBody(1);
    defer {
        store.allocator.free(loaded.body);
        store.allocator.free(loaded.format);
    }
    try std.testing.expect(loaded.body.len > 0);
    try std.testing.expectEqualStrings("plain", loaded.format);
}

test "loadBody fails for a missing entry" {
    var store = try testStore();
    defer store.deinit();
    try std.testing.expectError(error.NotFound, store.loadBody(999));
}

test "listExportMeta returns decrypted id date and title" {
    var store = try testStore();
    defer store.deinit();
    const meta = try store.listExportMeta();
    defer store.freeExportMeta(meta);
    try std.testing.expectEqual(@as(usize, 3), meta.len);
    try std.testing.expectEqual(@as(i64, 1), meta[0].id);
    try std.testing.expectEqualStrings("2026-08-28", meta[0].date);
    try std.testing.expectEqualStrings("Morning walk", meta[0].title);
}

test "replaceEmbeddings stores and replaces vectors" {
    var store = try testStore();
    defer store.deinit();

    const chunks = [_][]const u8{ "chunk one", "chunk two" };
    const vec1 = [_]f32{ 0.1, 0.2, 0.3 };
    const vec2 = [_]f32{ 0.4, 0.5, 0.6 };
    const vectors = [_][]const f32{ &vec1, &vec2 };
    try store.replaceEmbeddings(1, &chunks, &vectors, "nomic-embed-text:v1.5");

    // Replace with different chunks — old ones should be gone.
    const chunks2 = [_][]const u8{"new chunk"};
    const vec3 = [_]f32{ 0.7, 0.8, 0.9 };
    const vectors2 = [_][]const f32{&vec3};
    try store.replaceEmbeddings(1, &chunks2, &vectors2, "nomic-embed-text:v1.5");

    // Verify via loadBody that the entry still exists (embeddings are stored separately).
    const loaded = try store.loadBody(1);
    defer {
        store.allocator.free(loaded.body);
        store.allocator.free(loaded.format);
    }
}

test "delete removes embeddings with the entry" {
    var store = try testStore();
    defer store.deinit();

    const chunks = [_][]const u8{"chunk one"};
    const vec = [_]f32{ 0.1, 0.2, 0.3 };
    const vectors = [_][]const f32{&vec};
    try store.replaceEmbeddings(1, &chunks, &vectors, "nomic-embed-text:v1.5");

    var output: [256]u8 = undefined;
    _ = try store.delete("{\"id\":1}", &output);

    // The entry should be gone.
    try std.testing.expectError(error.NotFound, store.loadBody(1));
}

test "delete removes dreamed memories including pinned and hidden" {
    var store = try testStore();
    defer store.deinit();
    const vec = [_]f32{ 1, 0, 0 };
    const facts = [_]NewFact{
        .{ .kind = "profile", .subject = "user", .fact = "Keeps a journal", .embedding = null },
        .{ .kind = "fact", .subject = "Maya", .fact = "Lives nearby", .embedding = &vec },
    };
    const events = [_]NewEvent{.{ .event = "Walked the creek", .occurred_at = "2026-08-28", .embedding = &vec }};
    _ = try store.commitDreamMemory(.entry, 1, &facts, &events, "nomic-embed-text:v1.5");

    _ = try store.saveMemory(.{
        .kind = .fact,
        .id = 2,
        .subject = "Maya",
        .fact = "Lives across town",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });
    try store.deleteMemory(.event, 1);
    _ = try store.saveMemory(.{
        .kind = .fact,
        .subject = "Sam",
        .fact = "Brought soup",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });

    try std.testing.expectEqual(@as(i64, 2), try countSourceFacts(&store, "entry", 1));
    try std.testing.expectEqual(@as(i64, 1), try countSourceEvents(&store, "entry", 1));
    try std.testing.expectEqual(@as(i64, 1), try countSourceDreamState(&store, "entry", 1));

    var output: [256]u8 = undefined;
    _ = try store.delete("{\"id\":1}", &output);

    try std.testing.expectEqual(@as(i64, 0), try countSourceFacts(&store, "entry", 1));
    try std.testing.expectEqual(@as(i64, 0), try countSourceEvents(&store, "entry", 1));
    try std.testing.expectEqual(@as(i64, 0), try countSourceDreamState(&store, "entry", 1));

    var list_out: [4096]u8 = undefined;
    const json = try store.listMemories(&list_out);
    try std.testing.expect(std.mem.indexOf(u8, json, "Brought soup") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Keeps a journal") == null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Lives nearby") == null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Lives across town") == null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Walked the creek") == null);
    try std.testing.expectEqual(@as(i64, 1), try countSourceFacts(&store, user_memory_source, 0));
}

test "delete leaves memories from another entry" {
    var store = try testStore();
    defer store.deinit();
    const vec = [_]f32{ 1, 0, 0 };
    const first = [_]NewFact{.{ .kind = "fact", .subject = "Maya", .fact = "Lives nearby", .embedding = &vec }};
    const second = [_]NewFact{.{ .kind = "fact", .subject = "Sam", .fact = "Brought soup", .embedding = &vec }};
    _ = try store.commitDreamMemory(.entry, 1, &first, &.{}, "nomic-embed-text:v1.5");
    _ = try store.commitDreamMemory(.entry, 2, &second, &.{}, "nomic-embed-text:v1.5");

    var output: [256]u8 = undefined;
    _ = try store.delete("{\"id\":1}", &output);

    try std.testing.expectEqual(@as(i64, 0), try countSourceFacts(&store, "entry", 1));
    try std.testing.expectEqual(@as(i64, 1), try countSourceFacts(&store, "entry", 2));
    var list_out: [4096]u8 = undefined;
    const json = try store.listMemories(&list_out);
    try std.testing.expect(std.mem.indexOf(u8, json, "Brought soup") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Lives nearby") == null);
}

test "commitDreamMemory on a missing source inserts nothing" {
    var store = try testStore();
    defer store.deinit();
    var output: [256]u8 = undefined;
    _ = try store.delete("{\"id\":1}", &output);

    const vec = [_]f32{ 1, 0, 0 };
    const facts = [_]NewFact{.{ .kind = "fact", .subject = "Maya", .fact = "Should not land", .embedding = &vec }};
    const events = [_]NewEvent{.{ .event = "Should not land either", .occurred_at = "2026-08-28", .embedding = &vec }};
    const written = try store.commitDreamMemory(.entry, 1, &facts, &events, "nomic-embed-text:v1.5");
    try std.testing.expectEqual(@as(usize, 0), written.facts);
    try std.testing.expectEqual(@as(usize, 0), written.events);
    try std.testing.expectEqual(@as(i64, 0), try countSourceFacts(&store, "entry", 1));
    try std.testing.expectEqual(@as(i64, 0), try countSourceEvents(&store, "entry", 1));
    try std.testing.expectEqual(@as(i64, 0), try countSourceDreamState(&store, "entry", 1));
}

test "pending embeddings include entries that were never embedded" {
    var store = try testStore();
    defer store.deinit();
    var output: [256]u8 = undefined;
    const json = try store.listPendingEmbeddings(&output);
    try std.testing.expectEqualStrings("{\"ids\":[1,2,3]}", json);
}

test "pending embeddings skip an entry whose embedding is current" {
    var store = try testStore();
    defer store.deinit();
    const chunks = [_][]const u8{"chunk one"};
    const vec = [_]f32{ 0.1, 0.2, 0.3 };
    const vectors = [_][]const f32{&vec};
    try store.replaceEmbeddings(1, &chunks, &vectors, "nomic-embed-text:v1.5");

    var output: [256]u8 = undefined;
    const json = try store.listPendingEmbeddings(&output);
    try std.testing.expectEqualStrings("{\"ids\":[2,3]}", json);
}

test "pending embeddings include an entry edited after it was embedded" {
    var store = try testStore();
    defer store.deinit();
    const chunks = [_][]const u8{"chunk one"};
    const vec = [_]f32{ 0.1, 0.2, 0.3 };
    const vectors = [_][]const f32{&vec};
    try store.replaceEmbeddings(1, &chunks, &vectors, "nomic-embed-text:v1.5");
    // strftime fractional seconds are milliseconds; wait so the save is later.
    std.Io.sleep(std.testing.io, .fromMilliseconds(20), .awake) catch {};

    var save_out: [256]u8 = undefined;
    _ = try store.save(
        "{\"id\":1,\"title\":\"Morning walk\",\"date\":\"2026-08-28\",\"wordCount\":2,\"format\":\"plain\",\"offset\":0,\"chunk\":\"Edited later.\",\"done\":true}",
        &save_out,
    );

    var output: [256]u8 = undefined;
    const json = try store.listPendingEmbeddings(&output);
    try std.testing.expectEqualStrings("{\"ids\":[1,2,3]}", json);
}

// --- encrypted store ---

const EncRig = struct {
    vault: vault_mod.Vault,
    store: Store,

    /// Initializes in place: the vault borrows the store's database and the
    /// store points back at the vault, so the rig must not move afterwards.
    fn init(self: *EncRig, password: []const u8) !void {
        const open_result = try native_sdk.RelationalStore.openMemoryMigrated(std.testing.allocator, &migrations);
        const db = switch (open_result.outcome) {
            .ok => open_result.database.?,
            else => return error.SqliteMigrationFailed,
        };
        self.store = Store.init(std.testing.allocator, db);
        self.vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &self.store.db);
        self.store.vault = &self.vault;
        try self.vault.enable(password);
    }

    fn deinit(self: *EncRig) void {
        self.vault.deinit();
        self.store.deinit();
    }

    /// The raw stored title, straight from the database with no decryption.
    fn rawTitle(self: *EncRig, id: i64) ![]u8 {
        var rows = QueryRows.init(std.testing.allocator);
        defer rows.deinit();
        const outcome = self.store.db.query(
            "SELECT id, title FROM journal_entry WHERE id = ?1;",
            &.{.{ .integer = id }},
            &rows,
            QueryRows.collect,
        );
        if (outcome != .ok or rows.failed or rows.rows.items.len == 0) return error.SqliteQueryFailed;
        const row = rows.rows.items[0];
        const title = try std.testing.allocator.dupe(u8, row.title);
        return title;
    }

    /// The raw stored summary, straight from the database with no decryption.
    fn rawSummary(self: *EncRig, entry_id: i64) ![]u8 {
        var rows = ChunkTextRows.init(std.testing.allocator);
        defer rows.deinit();
        const outcome = self.store.db.query(
            "SELECT rowid, summary AS chunk_text FROM entry_summary WHERE entry_id = ?1;",
            &.{.{ .integer = entry_id }},
            &rows,
            ChunkTextRows.collect,
        );
        if (outcome != .ok or rows.failed or rows.rows.items.len == 0) return error.SqliteQueryFailed;
        return try std.testing.allocator.dupe(u8, rows.rows.items[0].text);
    }
};

test "encrypted save and get round-trip through ciphertext" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    var save_out: [8192]u8 = undefined;
    const saved = try rig.store.save(
        "{\"id\":null,\"title\":\"Secret page\",\"date\":\"2026-09-06\",\"wordCount\":2,\"format\":\"plain\",\"offset\":0,\"chunk\":\"Words nobody should read.\",\"done\":true}",
        &save_out,
    );
    try std.testing.expect(std.mem.indexOf(u8, saved, "\"id\":4") != null);

    // On disk, title and body are prefixed ciphertext.
    const raw = try rig.rawTitle(4);
    defer std.testing.allocator.free(raw);
    try std.testing.expect(vault_mod.Vault.isEncryptedField(raw));
    try std.testing.expect(std.mem.indexOf(u8, raw, "Secret page") == null);

    // Through the store, they read back as plain text.
    var get_out: [8192]u8 = undefined;
    const loaded = try rig.store.get("{\"id\":4,\"offset\":0}", &get_out);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "Secret page") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "Words nobody should read.") != null);
}

test "encrypted list decrypts titles" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();
    var output: [8192]u8 = undefined;
    const json = try rig.store.list(&output);
    // Seed rows are still plaintext until a rewrite; they read fine either way.
    try std.testing.expect(std.mem.indexOf(u8, json, "Morning walk") != null);
}

test "encrypted search matches plaintext seed rows and new ciphertext rows" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    var save_out: [8192]u8 = undefined;
    _ = try rig.store.save(
        "{\"id\":null,\"title\":\"Hidden note\",\"date\":\"2026-09-06\",\"wordCount\":3,\"format\":\"plain\",\"offset\":0,\"chunk\":\"A fog of my own.\",\"done\":true}",
        &save_out,
    );

    var output: [8192]u8 = undefined;
    const json = try rig.store.search("{\"query\":\"fog\"}", &output);
    // The plaintext seed row and the freshly encrypted row both match.
    try std.testing.expect(std.mem.indexOf(u8, json, "\"id\":1") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"id\":4") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Hidden note") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"id\":2") == null);
}

test "encrypted search keeps newest-first order" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    var save_out: [8192]u8 = undefined;
    _ = try rig.store.save(
        "{\"id\":null,\"title\":\"Newer fog\",\"date\":\"2026-09-06\",\"wordCount\":2,\"format\":\"plain\",\"offset\":0,\"chunk\":\"fog again\",\"done\":true}",
        &save_out,
    );

    var output: [8192]u8 = undefined;
    const json = try rig.store.search("{\"query\":\"fog\"}", &output);
    const newer = std.mem.indexOf(u8, json, "\"id\":4").?;
    const seed = std.mem.indexOf(u8, json, "\"id\":1").?;
    try std.testing.expect(newer < seed);
}

test "replaceEmbeddings stores chunk text encrypted" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    const chunks = [_][]const u8{"a chunk of writing"};
    const vec = [_]f32{ 0.1, 0.2, 0.3 };
    const vectors = [_][]const f32{&vec};
    try rig.store.replaceEmbeddings(1, &chunks, &vectors, "nomic-embed-text:v1.5");

    var rows = ChunkTextRows.init(std.testing.allocator);
    defer rows.deinit();
    const outcome = rig.store.db.query(
        "SELECT rowid, chunk_text FROM entry_embedding WHERE entry_id = 1;",
        &.{},
        &rows,
        ChunkTextRows.collect,
    );
    try std.testing.expect(outcome == .ok);
    try std.testing.expectEqual(@as(usize, 1), rows.rows.items.len);
    const stored = rows.rows.items[0].text;
    try std.testing.expect(vault_mod.Vault.isEncryptedField(stored));
    try std.testing.expect(std.mem.indexOf(u8, stored, "a chunk of writing") == null);
}

test "store reads and writes refuse when the key is missing" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();
    const events =
        \\[{"type":"message.received","data":{"message":"Hello fog","turnId":"turn_0"}}]
    ;
    _ = try saveChatEvents(&rig.store, "Hidden chat", events);
    var save_out: [256]u8 = undefined;
    _ = try rig.store.agentInstructionsSave("{\"user\":\"Hidden prompt.\"}", &save_out);

    // Encrypt the seed rows too, so every stored field needs the key.
    try rig.store.setRowsEncrypted(true);

    // Simulate a fresh launch: encryption is on, but nobody has unlocked.
    rig.vault.deinit();
    rig.vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &rig.store.db);
    rig.store.vault = &rig.vault;

    var output: [8192]u8 = undefined;
    try std.testing.expectError(error.Locked, rig.store.list(&output));
    try std.testing.expectError(error.Locked, rig.store.get("{\"id\":1,\"offset\":0}", &output));
    try std.testing.expectError(error.Locked, rig.store.search("{\"query\":\"fog\"}", &output));
    try std.testing.expectError(error.Locked, rig.store.chatSearch("{\"query\":\"fog\"}", &output));
    try std.testing.expectError(error.Locked, rig.store.save(
        "{\"id\":null,\"title\":\"Nope\",\"date\":\"2026-09-06\",\"wordCount\":1,\"format\":\"plain\",\"offset\":0,\"chunk\":\"no\",\"done\":true}",
        &output,
    ));
    try std.testing.expectError(error.Locked, rig.store.loadBody(1));
    try std.testing.expectError(error.Locked, rig.store.agentInstructionsGet(&output));
    try std.testing.expectError(error.Locked, rig.store.agentInstructionsSave("{\"user\":\"Nope\"}", &output));
}

test "setRowsEncrypted rewrites rows in both directions" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    // Seed rows start as plaintext.
    const before = try rig.rawTitle(1);
    defer std.testing.allocator.free(before);
    try std.testing.expectEqualStrings("Morning walk", before);

    try rig.store.setRowsEncrypted(true);
    const encrypted = try rig.rawTitle(1);
    defer std.testing.allocator.free(encrypted);
    try std.testing.expect(vault_mod.Vault.isEncryptedField(encrypted));

    var output: [8192]u8 = undefined;
    const json = try rig.store.search("{\"query\":\"fog\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"id\":1") != null);

    try rig.store.setRowsEncrypted(false);
    const after = try rig.rawTitle(1);
    defer std.testing.allocator.free(after);
    try std.testing.expectEqualStrings("Morning walk", after);
}

test "setRowsEncrypted rewrites agent instructions" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    const insert = rig.store.db.exec(&.{.{
        .sql = "INSERT INTO agent_instruction (key, value) VALUES (?1, ?2);",
        .params = &.{ .{ .text = "user" }, .{ .text = "Be direct." } },
    }});
    try std.testing.expect(insert == .ok);

    try rig.store.setRowsEncrypted(true);
    var rows = KvRows.init(std.testing.allocator);
    defer rows.deinit();
    const outcome = rig.store.db.query(
        "SELECT key, value FROM agent_instruction WHERE key = 'user';",
        &.{},
        &rows,
        KvRows.collect,
    );
    try std.testing.expect(outcome == .ok);
    try std.testing.expectEqual(@as(usize, 1), rows.rows.items.len);
    try std.testing.expect(vault_mod.Vault.isEncryptedField(rows.rows.items[0].value));
    try std.testing.expect(std.mem.indexOf(u8, rows.rows.items[0].value, "Be direct.") == null);

    var output: [16384]u8 = undefined;
    const json = try rig.store.agentInstructionsGet(&output);
    try std.testing.expect(std.mem.indexOf(u8, json, "Be direct.") != null);

    try rig.store.setRowsEncrypted(false);
    var after = KvRows.init(std.testing.allocator);
    defer after.deinit();
    const after_outcome = rig.store.db.query(
        "SELECT key, value FROM agent_instruction WHERE key = 'user';",
        &.{},
        &after,
        KvRows.collect,
    );
    try std.testing.expect(after_outcome == .ok);
    try std.testing.expectEqualStrings("Be direct.", after.rows.items[0].value);
}

test "setRowsEncrypted rewrites entry summaries" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    // A summary written before encryption sits in plaintext until the rewrite.
    const insert = rig.store.db.exec(&.{.{
        .sql = "INSERT INTO entry_summary (entry_id, summary, embedding, model, embed_model) VALUES (?1, ?2, ?3, ?4, ?5);",
        .params = &.{
            .{ .integer = 1 },
            .{ .text = "A walk in the fog." },
            .{ .blob = "vec" },
            .{ .text = "qwen3:8b" },
            .{ .text = "nomic-embed-text:v1.5" },
        },
    }});
    try std.testing.expect(insert == .ok);

    try rig.store.setRowsEncrypted(true);
    const encrypted = try rig.rawSummary(1);
    defer std.testing.allocator.free(encrypted);
    try std.testing.expect(vault_mod.Vault.isEncryptedField(encrypted));
    try std.testing.expect(std.mem.indexOf(u8, encrypted, "A walk in the fog.") == null);

    try rig.store.setRowsEncrypted(false);
    const decrypted = try rig.rawSummary(1);
    defer std.testing.allocator.free(decrypted);
    try std.testing.expectEqualStrings("A walk in the fog.", decrypted);
}

test "setSecureDelete turns on for the write connection" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    try rig.store.setSecureDelete(true);
    var statement = try rig.store.db.write_db.prepareOne("PRAGMA secure_delete;");
    defer statement.finalize();
    try std.testing.expectEqual(.row, try statement.step());
    try std.testing.expectEqual(@as(i64, 1), statement.columnInt(0));
}

test "scrubStorage keeps encrypted rows readable" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    try rig.store.setRowsEncrypted(true);
    try rig.store.scrubStorage();

    var output: [8192]u8 = undefined;
    const loaded = try rig.store.get("{\"id\":1,\"offset\":0}", &output);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "Morning walk") != null);
    const found = try rig.store.search("{\"query\":\"fog\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, found, "\"id\":1") != null);
}

const FileRig = struct {
    vault: vault_mod.Vault,
    store: Store,

    fn init(self: *FileRig, data_dir: []const u8) !void {
        const open_result = try native_sdk.RelationalStore.openMigrated(std.testing.allocator, data_dir, &migrations);
        const db = switch (open_result.outcome) {
            .ok => open_result.database.?,
            else => return error.SqliteMigrationFailed,
        };
        self.store = Store.init(std.testing.allocator, db);
        self.vault = try vault_mod.Vault.init(std.testing.allocator, std.testing.io, &self.store.db);
        self.store.vault = &self.vault;
    }

    fn deinit(self: *FileRig) void {
        self.vault.deinit();
        self.store.deinit();
    }
};

fn readDirFile(dir: std.Io.Dir, name: [:0]const u8) ![]u8 {
    const io = std.testing.io;
    var file = dir.openFile(io, name, .{}) catch |err| switch (err) {
        error.FileNotFound => return std.testing.allocator.dupe(u8, ""),
        else => return err,
    };
    defer file.close(io);
    var read_buffer: [4096]u8 = undefined;
    var reader = file.reader(io, &read_buffer);
    return reader.interface.allocRemaining(std.testing.allocator, .limited(16 * 1024 * 1024));
}

/// Whether `app.db` or its write-ahead log still holds `needle`. Used by the
/// tests that prove a rebuild removed old bytes from the file.
pub fn dbFilesContain(dir: std.Io.Dir, needle: []const u8) !bool {
    const db = try readDirFile(dir, "app.db");
    defer std.testing.allocator.free(db);
    if (std.mem.indexOf(u8, db, needle) != null) return true;
    const wal = try readDirFile(dir, "app.db-wal");
    defer std.testing.allocator.free(wal);
    return std.mem.indexOf(u8, wal, needle) != null;
}

test "scrubStorage restores the SQL sandbox after a rebuild" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    try rig.store.setRowsEncrypted(true);
    try rig.store.scrubStorage();
    try std.testing.expectError(error.Misuse, rig.store.db.write_db.exec("ATTACH DATABASE ':memory:' AS escaped;"));
}

test "scrubStorage fails while another connection is writing" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = ".keep", .data = "" });
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const keep_len = try tmp.dir.realPathFile(io, ".keep", &path_buf);
    const data_dir = std.fs.path.dirname(path_buf[0..keep_len]) orelse return error.NoDir;

    var rig: FileRig = undefined;
    try rig.init(data_dir);
    defer rig.deinit();
    try rig.vault.enable("correct horse");
    try rig.store.setRowsEncrypted(true);

    var extra = try @TypeOf(rig.store.db.write_db).open(rig.store.db.path);
    defer extra.close();
    try extra.exec("BEGIN IMMEDIATE;");
    try extra.exec("UPDATE journal_entry SET title = title WHERE id = 1;");
    try std.testing.expectError(error.Busy, rig.store.scrubStorage());
    try extra.exec("ROLLBACK;");
    try rig.store.scrubStorage();
}

test "a mid-rewrite crash leaves plaintext until the rewrite resumes" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = ".keep", .data = "" });
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const keep_len = try tmp.dir.realPathFile(io, ".keep", &path_buf);
    const data_dir = std.fs.path.dirname(path_buf[0..keep_len]) orelse return error.NoDir;

    const canary = "SAGE_REWRITE_CRASH_CANARY_c4e8a1b0d2f6";
    {
        var rig: FileRig = undefined;
        try rig.init(data_dir);
        defer rig.deinit();
        var output: [8192]u8 = undefined;
        _ = try rig.store.save(
            "{\"id\":null,\"title\":\"Rewrite canary\",\"date\":\"2026-09-08\",\"wordCount\":1,\"format\":\"plain\",\"offset\":0,\"chunk\":\"SAGE_REWRITE_CRASH_CANARY_c4e8a1b0d2f6\",\"done\":true}",
            &output,
        );
        try rig.vault.enable("correct horse");
        try std.testing.expect(rig.vault.rewrite_pending);
    }
    try std.testing.expect(try dbFilesContain(tmp.dir, canary));

    {
        var rig: FileRig = undefined;
        try rig.init(data_dir);
        defer rig.deinit();
        try std.testing.expect(rig.vault.enabled);
        try std.testing.expect(rig.vault.rewrite_pending);
        try rig.vault.unlockWithPassword("correct horse");
        try rig.store.setRowsEncrypted(true);
        try rig.vault.setRewritePending(false);
        try rig.store.scrubStorage();
        try rig.vault.setScrubPending(false);
        var output: [8192]u8 = undefined;
        const loaded = try rig.store.get("{\"id\":4,\"offset\":0}", &output);
        try std.testing.expect(std.mem.indexOf(u8, loaded, canary) != null);
    }
    try std.testing.expect(!try dbFilesContain(tmp.dir, canary));
}

test "scrubStorage removes plaintext bytes from the database file" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = ".keep", .data = "" });
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const keep_len = try tmp.dir.realPathFile(io, ".keep", &path_buf);
    const data_dir = std.fs.path.dirname(path_buf[0..keep_len]) orelse return error.NoDir;

    const canary = "SAGE_PLAINTEXT_SCRUB_CANARY_7b3e9f2a4c1d";
    {
        var rig: FileRig = undefined;
        try rig.init(data_dir);
        defer rig.deinit();
        var output: [8192]u8 = undefined;
        _ = try rig.store.save(
            "{\"id\":null,\"title\":\"Scrub canary\",\"date\":\"2026-09-08\",\"wordCount\":1,\"format\":\"plain\",\"offset\":0,\"chunk\":\"SAGE_PLAINTEXT_SCRUB_CANARY_7b3e9f2a4c1d\",\"done\":true}",
            &output,
        );
    }
    try std.testing.expect(try dbFilesContain(tmp.dir, canary));

    {
        var rig: FileRig = undefined;
        try rig.init(data_dir);
        defer rig.deinit();
        try rig.vault.enable("correct horse");
        try rig.store.setRowsEncrypted(true);
        try rig.store.scrubStorage();
        var output: [8192]u8 = undefined;
        const loaded = try rig.store.get("{\"id\":4,\"offset\":0}", &output);
        try std.testing.expect(std.mem.indexOf(u8, loaded, canary) != null);
    }
    try std.testing.expect(!try dbFilesContain(tmp.dir, canary));
    try std.testing.expect(!try dbFilesContain(tmp.dir, "counted the crows"));
}

test "deleteAllData removes wiped plaintext from the database file" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = ".keep", .data = "" });
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const keep_len = try tmp.dir.realPathFile(io, ".keep", &path_buf);
    const data_dir = std.fs.path.dirname(path_buf[0..keep_len]) orelse return error.NoDir;

    const canary = "SAGE_DELETE_ALL_CANARY_9d2c8e4f1a7b";
    {
        var rig: FileRig = undefined;
        try rig.init(data_dir);
        defer rig.deinit();
        var output: [8192]u8 = undefined;
        _ = try rig.store.save(
            "{\"id\":null,\"title\":\"Wipe canary\",\"date\":\"2026-09-13\",\"wordCount\":1,\"format\":\"plain\",\"offset\":0,\"chunk\":\"SAGE_DELETE_ALL_CANARY_9d2c8e4f1a7b\",\"done\":true}",
            &output,
        );
        try std.testing.expect(try dbFilesContain(tmp.dir, canary));
        _ = try rig.store.deleteAllData(&output);
        try std.testing.expectEqualStrings("{\"entries\":[]}", try rig.store.list(&output));
    }
    try std.testing.expect(!try dbFilesContain(tmp.dir, canary));
    try std.testing.expect(!try dbFilesContain(tmp.dir, "counted the crows"));
}

test "cosineSimilarity ranks a matching vector higher" {
    const query = [_]f32{ 1.0, 0.0, 0.0 };
    const close = [_]f32{ 0.9, 0.1, 0.0 };
    const far = [_]f32{ 0.0, 1.0, 0.0 };
    try std.testing.expect(cosineSimilarity(&query, &close) > cosineSimilarity(&query, &far));
}

test "semanticSearch returns the closest entry" {
    var store = try testStore();
    defer store.deinit();

    const chunks_a = [_][]const u8{"walked without headphones"};
    const vec_a = [_]f32{ 1.0, 0.0, 0.0 };
    const vectors_a = [_][]const f32{&vec_a};
    try store.replaceEmbeddings(1, &chunks_a, &vectors_a, "nomic-embed-text:v1.5");

    const chunks_b = [_][]const u8{"building Sage on this machine"};
    const vec_b = [_]f32{ 0.0, 1.0, 0.0 };
    const vectors_b = [_][]const f32{&vec_b};
    try store.replaceEmbeddings(2, &chunks_b, &vectors_b, "nomic-embed-text:v1.5");

    var output: [8192]u8 = undefined;
    var writer = std.Io.Writer.fixed(&output);
    const query = [_]f32{ 1.0, 0.0, 0.0 };
    try store.semanticSearch(&query, 5, &writer);
    const json = writer.buffered();
    const first = std.mem.indexOf(u8, json, "\"id\":1") orelse return error.TestUnexpectedResult;
    const second = std.mem.indexOf(u8, json, "\"id\":2") orelse return error.TestUnexpectedResult;
    try std.testing.expect(first < second);
    try std.testing.expect(std.mem.indexOf(u8, json, "walked without headphones") != null);
}

test "semanticSearch returns no rows when nothing is embedded" {
    var store = try testStore();
    defer store.deinit();
    var output: [256]u8 = undefined;
    var writer = std.Io.Writer.fixed(&output);
    const query = [_]f32{ 1.0, 0.0 };
    try store.semanticSearch(&query, 5, &writer);
    try std.testing.expectEqualStrings("{\"entries\":[]}", writer.buffered());
}

test "memory mode reset removes chats and memories but preserves journal indexes" {
    var store = try testStore();
    defer store.deinit();

    const vector = [_]f32{ 1, 0, 0 };
    const chunks = [_][]const u8{"journal words"};
    const vectors = [_][]const f32{&vector};
    try store.replaceEmbeddings(1, &chunks, &vectors, "nomic-embed-text:v1.5");
    try store.replaceSummary(1, "A journal summary.", &vector, "qwen3:8b", "nomic-embed-text:v1.5");

    const chat_insert = store.db.exec(&.{.{
        .sql = "INSERT INTO chat_conversation (id, title, events) VALUES (?1, ?2, ?3);",
        .params = &.{ .{ .integer = 44 }, .{ .text = "Old chat" }, .{ .text = "" } },
    }});
    try std.testing.expect(chat_insert == .ok);
    const facts = [_]NewFact{.{ .kind = "fact", .subject = "Maya", .fact = "Old memory", .embedding = &vector }};
    const events = [_]NewEvent{.{ .event = "Old event", .occurred_at = "2026-09-01", .embedding = &vector }};
    _ = try store.commitDreamMemory(.conversation, 44, &facts, &events, "nomic-embed-text:v1.5");
    try store.markDreamed(.entry, 1);

    try store.disableMemoriesAndChats();

    var memories_out: [4096]u8 = undefined;
    const memories = try store.listMemories(&memories_out);
    try std.testing.expect(std.mem.indexOf(u8, memories, "Old memory") == null);
    try std.testing.expect(std.mem.indexOf(u8, memories, "Old event") == null);
    var chats_out: [4096]u8 = undefined;
    const chats = try store.chatList(&chats_out);
    try std.testing.expect(std.mem.indexOf(u8, chats, "Old chat") == null);
    try std.testing.expect(!(try store.entryEmbeddingsStale(1)));
    try std.testing.expect(!(try store.entrySummaryStale(1)));

    const pending_before_enable = try store.listPendingDream(false);
    defer store.allocator.free(pending_before_enable);
    for (pending_before_enable) |item| {
        try std.testing.expect(!(item.source == .entry and item.id == 1));
        try std.testing.expect(item.source != .conversation);
    }

    try store.refreshMemoryExtractions();
    const pending_after_enable = try store.listPendingDream(true);
    defer store.allocator.free(pending_after_enable);
    try std.testing.expectEqual(@as(usize, 3), pending_after_enable.len);
    try std.testing.expect(!(try store.entryEmbeddingsStale(1)));
    try std.testing.expect(!(try store.entrySummaryStale(1)));
}

test "pending summaries include entries that were never summarized" {
    var store = try testStore();
    defer store.deinit();
    var output: [256]u8 = undefined;
    const json = try store.listPendingSummaries(&output);
    try std.testing.expectEqualStrings("{\"ids\":[1,2,3]}", json);
}

test "pending summaries skip an entry whose summary is current" {
    var store = try testStore();
    defer store.deinit();
    const vec = [_]f32{ 0.1, 0.2, 0.3 };
    try store.replaceSummary(1, "A walk in the fog.", &vec, "qwen3:8b", "nomic-embed-text:v1.5");

    var output: [256]u8 = undefined;
    const json = try store.listPendingSummaries(&output);
    try std.testing.expectEqualStrings("{\"ids\":[2,3]}", json);
}

test "pending summaries include an entry edited after it was summarized" {
    var store = try testStore();
    defer store.deinit();
    const vec = [_]f32{ 0.1, 0.2, 0.3 };
    try store.replaceSummary(1, "A walk in the fog.", &vec, "qwen3:8b", "nomic-embed-text:v1.5");
    std.Io.sleep(std.testing.io, .fromMilliseconds(20), .awake) catch {};

    var save_out: [256]u8 = undefined;
    _ = try store.save(
        "{\"id\":1,\"title\":\"Morning walk\",\"date\":\"2026-08-28\",\"wordCount\":2,\"format\":\"plain\",\"offset\":0,\"chunk\":\"Edited later.\",\"done\":true}",
        &save_out,
    );

    var output: [256]u8 = undefined;
    const json = try store.listPendingSummaries(&output);
    try std.testing.expectEqualStrings("{\"ids\":[1,2,3]}", json);
}

test "semanticSearchSummaries returns the closest entry" {
    var store = try testStore();
    defer store.deinit();

    const vec_a = [_]f32{ 1.0, 0.0, 0.0 };
    try store.replaceSummary(1, "Walked without headphones.", &vec_a, "qwen3:8b", "nomic-embed-text:v1.5");
    const vec_b = [_]f32{ 0.0, 1.0, 0.0 };
    try store.replaceSummary(2, "Building Sage on this machine.", &vec_b, "qwen3:8b", "nomic-embed-text:v1.5");

    var output: [8192]u8 = undefined;
    var writer = std.Io.Writer.fixed(&output);
    const query = [_]f32{ 1.0, 0.0, 0.0 };
    try store.semanticSearchSummaries(&query, 5, &writer);
    const json = writer.buffered();
    const first = std.mem.indexOf(u8, json, "\"id\":1") orelse return error.TestUnexpectedResult;
    const second = std.mem.indexOf(u8, json, "\"id\":2") orelse return error.TestUnexpectedResult;
    try std.testing.expect(first < second);
    try std.testing.expect(std.mem.indexOf(u8, json, "Walked without headphones.") != null);
}

test "semanticSearchSummaries returns no rows when nothing is summarized" {
    var store = try testStore();
    defer store.deinit();
    var output: [256]u8 = undefined;
    var writer = std.Io.Writer.fixed(&output);
    const query = [_]f32{ 1.0, 0.0 };
    try store.semanticSearchSummaries(&query, 5, &writer);
    try std.testing.expectEqualStrings("{\"entries\":[]}", writer.buffered());
}

test "encrypted replaceSummary stores ciphertext" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    const vec = [_]f32{ 0.1, 0.2, 0.3 };
    try rig.store.replaceSummary(1, "A walk in the fog.", &vec, "qwen3:8b", "nomic-embed-text:v1.5");

    var rows = ChunkTextRows.init(std.testing.allocator);
    defer rows.deinit();
    const outcome = rig.store.db.query(
        "SELECT rowid, summary AS chunk_text FROM entry_summary WHERE entry_id = 1;",
        &.{},
        &rows,
        ChunkTextRows.collect,
    );
    try std.testing.expect(outcome == .ok);
    try std.testing.expectEqual(@as(usize, 1), rows.rows.items.len);
    try std.testing.expect(vault_mod.Vault.isEncryptedField(rows.rows.items[0].text));
    try std.testing.expect(std.mem.indexOf(u8, rows.rows.items[0].text, "A walk in the fog.") == null);

    var output: [8192]u8 = undefined;
    var writer = std.Io.Writer.fixed(&output);
    try rig.store.semanticSearchSummaries(&vec, 5, &writer);
    try std.testing.expect(std.mem.indexOf(u8, writer.buffered(), "A walk in the fog.") != null);
}

test "listPendingDream includes seed entries and skips after indexes and Dream are current" {
    var store = try testStore();
    defer store.deinit();
    const pending = try store.listPendingDream(false);
    defer store.allocator.free(pending);
    try std.testing.expectEqual(@as(usize, 3), pending.len);
    try std.testing.expect(try store.entryEmbeddingsStale(1));
    try std.testing.expect(try store.entrySummaryStale(1));
    for (pending) |item| {
        if (item.source == .entry and item.id == 1) {
            try std.testing.expect(item.needs_memory_extraction);
        }
    }

    const vector = [_]f32{ 0.1, 0.2, 0.3 };
    const chunks = [_][]const u8{"Morning walk"};
    const vectors = [_][]const f32{&vector};
    try store.replaceEmbeddings(1, &chunks, &vectors, "nomic-embed-text:v1.5");
    try store.replaceSummary(1, "A morning walk.", &vector, "qwen3:8b", "nomic-embed-text:v1.5");
    try store.markDreamed(.entry, 1);

    const after = try store.listPendingDream(false);
    defer store.allocator.free(after);
    try std.testing.expectEqual(@as(usize, 2), after.len);
    for (after) |item| {
        try std.testing.expect(!(item.source == .entry and item.id == 1));
    }
}

test "listPendingDream schedules stale chat indexes only with memory enabled" {
    var store = try testStore();
    defer store.deinit();
    const chat_id = try saveChatEvents(
        &store,
        "Index repair",
        "[{\"type\":\"message.received\",\"data\":{\"message\":\"hello\"}}]",
    );
    try store.markDreamed(.conversation, chat_id);
    var output: [256]u8 = undefined;
    _ = try store.deleteEmbeddings(&output);

    const enabled_pending = try store.listPendingDream(true);
    defer store.allocator.free(enabled_pending);
    var found_chat = false;
    for (enabled_pending) |item| {
        if (item.source == .conversation and item.id == chat_id) {
            found_chat = true;
            try std.testing.expect(!item.needs_memory_extraction);
        }
    }
    try std.testing.expect(found_chat);

    const disabled_pending = try store.listPendingDream(false);
    defer store.allocator.free(disabled_pending);
    for (disabled_pending) |item| {
        try std.testing.expect(!(item.source == .conversation and item.id == chat_id));
    }
}

test "listPendingDream skips index-only entries without text" {
    var store = try testStore();
    defer store.deinit();
    const insert = store.db.exec(&.{.{
        .sql = "INSERT INTO journal_entry (entry_date, title, body, word_count, body_format, updated_at) VALUES ('2026-09-20', 'Empty page', '', 0, 'plain', '2026-09-20T00:00:00.000Z');",
        .params = &.{},
    }});
    try std.testing.expect(insert == .ok);
    try store.markDreamed(.entry, 4);
    var output: [256]u8 = undefined;
    _ = try store.deleteEmbeddings(&output);

    const pending = try store.listPendingDream(false);
    defer store.allocator.free(pending);
    for (pending) |item| {
        try std.testing.expect(!(item.source == .entry and item.id == 4));
    }
}

test "lastDreamedAt is empty until markDreamed" {
    var store = try testStore();
    defer store.deinit();
    try std.testing.expect((try store.lastDreamedAt()) == null);

    try store.markDreamed(.entry, 1);
    const first = (try store.lastDreamedAt()) orelse return error.TestExpectedEqual;
    defer store.allocator.free(first);
    try std.testing.expect(std.mem.indexOf(u8, first, "T") != null);
    try std.testing.expect(std.mem.endsWith(u8, first, "Z"));
}

test "commitDreamMemory ranks facts and lists profile rows" {
    var store = try testStore();
    defer store.deinit();
    const near = [_]f32{ 1, 0, 0 };
    const far = [_]f32{ 0, 1, 0 };
    const facts = [_]NewFact{
        .{ .kind = "fact", .subject = "Maya", .fact = "Lives nearby", .embedding = &near },
        .{ .kind = "fact", .subject = "user", .fact = "Builds software", .embedding = &far },
        .{ .kind = "profile", .subject = "user", .fact = "Prefers quiet walks", .embedding = null },
    };
    const written = try store.commitDreamMemory(.entry, 1, &facts, &.{}, "nomic-embed-text:v1.5");
    try std.testing.expectEqual(@as(usize, 3), written.facts);
    try std.testing.expectEqual(@as(usize, 0), written.events);

    var output: [2048]u8 = undefined;
    var writer = std.Io.Writer.fixed(&output);
    try store.semanticSearchFacts(&near, 5, &writer);
    const ranked = writer.buffered();
    const maya = std.mem.indexOf(u8, ranked, "Lives nearby").?;
    const builds = std.mem.indexOf(u8, ranked, "Builds software").?;
    try std.testing.expect(maya < builds);
    try std.testing.expect(std.mem.indexOf(u8, ranked, "Prefers quiet walks") == null);
    try std.testing.expect(std.mem.indexOf(u8, ranked, "\"sourceType\":\"entry\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, ranked, "\"sourceId\":1") != null);

    var profile_out: [2048]u8 = undefined;
    var profile_writer = std.Io.Writer.fixed(&profile_out);
    try store.listProfile(profile_recall_limit, &profile_writer);
    const profile_json = profile_writer.buffered();
    try std.testing.expect(std.mem.indexOf(u8, profile_json, "Prefers quiet walks") != null);
    try std.testing.expect(std.mem.indexOf(u8, profile_json, "\"sourceType\":\"entry\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, profile_json, "\"sourceId\":1") != null);
}

test "commitDreamMemory ranks events" {
    var store = try testStore();
    defer store.deinit();
    const near = [_]f32{ 1, 0, 0 };
    const far = [_]f32{ 0, 1, 0 };
    const events = [_]NewEvent{
        .{ .event = "Walked the creek trail", .occurred_at = "2026-08-28", .embedding = &near },
        .{ .event = "Sat down to write", .occurred_at = "2026-08-31", .embedding = &far },
    };
    const written = try store.commitDreamMemory(.entry, 1, &.{}, &events, "nomic-embed-text:v1.5");
    try std.testing.expectEqual(@as(usize, 0), written.facts);
    try std.testing.expectEqual(@as(usize, 2), written.events);

    var output: [2048]u8 = undefined;
    var writer = std.Io.Writer.fixed(&output);
    try store.semanticSearchEvents(&near, 5, &writer);
    const ranked = writer.buffered();
    const walk = std.mem.indexOf(u8, ranked, "Walked the creek trail").?;
    const write = std.mem.indexOf(u8, ranked, "Sat down to write").?;
    try std.testing.expect(walk < write);
    try std.testing.expect(std.mem.indexOf(u8, ranked, "2026-08-28") != null);
    try std.testing.expect(std.mem.indexOf(u8, ranked, "\"sourceType\":\"entry\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, ranked, "\"sourceId\":1") != null);
}

test "commitDreamMemory replaces the same source instead of appending" {
    var store = try testStore();
    defer store.deinit();
    const first_vec = [_]f32{ 1, 0, 0 };
    const second_vec = [_]f32{ 0, 1, 0 };
    const first_facts = [_]NewFact{.{ .kind = "fact", .subject = "Maya", .fact = "Lives nearby", .embedding = &first_vec }};
    const first_events = [_]NewEvent{.{ .event = "Walked", .occurred_at = "2026-08-28", .embedding = &first_vec }};
    _ = try store.commitDreamMemory(.entry, 1, &first_facts, &first_events, "nomic-embed-text:v1.5");

    const second_facts = [_]NewFact{.{ .kind = "fact", .subject = "Maya", .fact = "Moved away", .embedding = &second_vec }};
    const second_events = [_]NewEvent{.{ .event = "Sat down", .occurred_at = "2026-08-31", .embedding = &second_vec }};
    const written = try store.commitDreamMemory(.entry, 1, &second_facts, &second_events, "nomic-embed-text:v1.5");
    try std.testing.expectEqual(@as(usize, 1), written.facts);
    try std.testing.expectEqual(@as(usize, 1), written.events);

    var fact_out: [2048]u8 = undefined;
    var fact_writer = std.Io.Writer.fixed(&fact_out);
    try store.semanticSearchFacts(&second_vec, 5, &fact_writer);
    try std.testing.expect(std.mem.indexOf(u8, fact_writer.buffered(), "Moved away") != null);
    try std.testing.expect(std.mem.indexOf(u8, fact_writer.buffered(), "Lives nearby") == null);

    var event_out: [2048]u8 = undefined;
    var event_writer = std.Io.Writer.fixed(&event_out);
    try store.semanticSearchEvents(&second_vec, 5, &event_writer);
    try std.testing.expect(std.mem.indexOf(u8, event_writer.buffered(), "Sat down") != null);
    try std.testing.expect(std.mem.indexOf(u8, event_writer.buffered(), "Walked") == null);

    const pending = try store.listPendingDream(true);
    defer store.allocator.free(pending);
    var found_index_only_entry = false;
    for (pending) |item| {
        if (item.source == .entry and item.id == 1) {
            found_index_only_entry = true;
            try std.testing.expect(!item.needs_memory_extraction);
        }
    }
    try std.testing.expect(found_index_only_entry);
}

test "commitDreamMemory skips a profile fact already stored by another source" {
    var store = try testStore();
    defer store.deinit();
    const first = [_]NewFact{.{ .kind = "profile", .subject = "user", .fact = "Keeps a journal", .embedding = null }};
    const first_written = try store.commitDreamMemory(.entry, 1, &first, &.{}, "nomic-embed-text:v1.5");
    try std.testing.expectEqual(@as(usize, 1), first_written.facts);

    const second = [_]NewFact{.{ .kind = "profile", .subject = "user", .fact = "keeps a journal", .embedding = null }};
    const second_written = try store.commitDreamMemory(.entry, 2, &second, &.{}, "nomic-embed-text:v1.5");
    try std.testing.expectEqual(@as(usize, 0), second_written.facts);

    var profile_out: [2048]u8 = undefined;
    var profile_writer = std.Io.Writer.fixed(&profile_out);
    try store.listProfile(profile_recall_limit, &profile_writer);
    const body = profile_writer.buffered();
    try std.testing.expect(std.mem.indexOf(u8, body, "Keeps a journal") != null);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, body, "\"id\":"));
}

test "listMemories omits hidden rows and profile save needs no embedding" {
    var store = try testStore();
    defer store.deinit();
    const vec = [_]f32{ 1, 0, 0 };
    const facts = [_]NewFact{
        .{ .kind = "profile", .subject = "user", .fact = "Keeps a journal", .embedding = null },
        .{ .kind = "fact", .subject = "Maya", .fact = "Lives nearby", .embedding = &vec },
    };
    const events = [_]NewEvent{.{ .event = "Walked the creek", .occurred_at = "2026-08-28", .embedding = &vec }};
    _ = try store.commitDreamMemory(.entry, 1, &facts, &events, "nomic-embed-text:v1.5");

    const profile_id = try store.saveMemory(.{
        .kind = .profile,
        .fact = "Prefers quiet walks",
        .model_name = "user",
    });
    try std.testing.expect(profile_id > 0);

    try store.deleteMemory(.fact, 2);
    try store.deleteMemory(.event, 1);

    var output: [4096]u8 = undefined;
    const json = try store.listMemories(&output);
    try std.testing.expect(std.mem.indexOf(u8, json, "Keeps a journal") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Prefers quiet walks") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Lives nearby") == null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Walked the creek") == null);

    var profile_out: [2048]u8 = undefined;
    var profile_writer = std.Io.Writer.fixed(&profile_out);
    try store.listProfile(profile_recall_limit, &profile_writer);
    try std.testing.expect(std.mem.indexOf(u8, profile_writer.buffered(), "Keeps a journal") != null);
}

test "saveMemory rejects a fact or event without an embedding" {
    var store = try testStore();
    defer store.deinit();
    try std.testing.expectError(error.InvalidEmbedding, store.saveMemory(.{
        .kind = .fact,
        .subject = "Maya",
        .fact = "Lives nearby",
        .model_name = "user",
    }));
    try std.testing.expectError(error.InvalidEmbedding, store.saveMemory(.{
        .kind = .event,
        .event = "Walked",
        .occurred_at = "2026-08-28",
        .model_name = "user",
    }));
}

test "pinned user edits survive a second Dream of the same source" {
    var store = try testStore();
    defer store.deinit();
    const vec = [_]f32{ 1, 0, 0 };
    const first_facts = [_]NewFact{.{ .kind = "fact", .subject = "Maya", .fact = "Lives nearby", .embedding = &vec }};
    const first_events = [_]NewEvent{.{ .event = "Walked", .occurred_at = "2026-08-28", .embedding = &vec }};
    _ = try store.commitDreamMemory(.entry, 1, &first_facts, &first_events, "nomic-embed-text:v1.5");

    _ = try store.saveMemory(.{
        .kind = .fact,
        .id = 1,
        .subject = "Maya",
        .fact = "Lives across town",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });
    _ = try store.saveMemory(.{
        .kind = .event,
        .id = 1,
        .event = "Sat down to write",
        .occurred_at = "2026-08-31",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });
    const user_id = try store.saveMemory(.{
        .kind = .fact,
        .subject = "Sam",
        .fact = "Brought soup",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });

    const second_facts = [_]NewFact{
        .{ .kind = "fact", .subject = "Maya", .fact = "Lives nearby", .embedding = &vec },
        .{ .kind = "fact", .subject = "Maya", .fact = "Moved away", .embedding = &vec },
    };
    const second_events = [_]NewEvent{
        .{ .event = "Walked", .occurred_at = "2026-08-28", .embedding = &vec },
        .{ .event = "Took a train", .occurred_at = "2026-09-01", .embedding = &vec },
    };
    const written = try store.commitDreamMemory(.entry, 1, &second_facts, &second_events, "nomic-embed-text:v1.5");
    try std.testing.expectEqual(@as(usize, 1), written.facts);
    try std.testing.expectEqual(@as(usize, 1), written.events);

    var list_out: [4096]u8 = undefined;
    const json = try store.listMemories(&list_out);
    try std.testing.expect(std.mem.indexOf(u8, json, "Lives across town") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Brought soup") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Moved away") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Sat down to write") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Took a train") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Lives nearby") == null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"Walked\"") == null);

    var fact_out: [2048]u8 = undefined;
    var fact_writer = std.Io.Writer.fixed(&fact_out);
    try store.semanticSearchFacts(&vec, 5, &fact_writer);
    try std.testing.expect(std.mem.indexOf(u8, fact_writer.buffered(), "Brought soup") != null);

    try store.deleteMemory(.fact, user_id);
    var after_out: [4096]u8 = undefined;
    const after = try store.listMemories(&after_out);
    try std.testing.expect(std.mem.indexOf(u8, after, "Brought soup") == null);
}

test "listMemories orders events by occurred_at newest first" {
    var store = try testStore();
    defer store.deinit();
    const vec = [_]f32{ 1, 0, 0 };
    _ = try store.saveMemory(.{
        .kind = .event,
        .event = "Earlier walk",
        .occurred_at = "2026-08-01",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });
    _ = try store.saveMemory(.{
        .kind = .event,
        .event = "Later trip",
        .occurred_at = "2026-09-01",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });
    _ = try store.saveMemory(.{
        .kind = .event,
        .event = "Unknown date",
        .occurred_at = "unknown",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });
    _ = try store.saveMemory(.{
        .kind = .event,
        .event = "Undated note",
        .occurred_at = "",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });

    var output: [4096]u8 = undefined;
    const json = try store.listMemories(&output);
    const later = std.mem.indexOf(u8, json, "Later trip") orelse return error.TestExpectedEqual;
    const earlier = std.mem.indexOf(u8, json, "Earlier walk") orelse return error.TestExpectedEqual;
    const unknown = std.mem.indexOf(u8, json, "Unknown date") orelse return error.TestExpectedEqual;
    const undated = std.mem.indexOf(u8, json, "Undated note") orelse return error.TestExpectedEqual;
    try std.testing.expect(later < earlier);
    try std.testing.expect(earlier < unknown);
    try std.testing.expect(earlier < undated);
}

test "listMemories includes the journal title for an event source" {
    var store = try testStore();
    defer store.deinit();
    const vec = [_]f32{ 1, 0, 0 };
    const facts = [_]NewFact{};
    const events = [_]NewEvent{.{ .event = "Walked the creek", .occurred_at = "2026-08-28", .embedding = &vec }};
    _ = try store.commitDreamMemory(.entry, 1, &facts, &events, "nomic-embed-text:v1.5");

    var output: [4096]u8 = undefined;
    const json = try store.listMemories(&output);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"sourceTitle\":\"Morning walk\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Walked the creek") != null);
}

test "memory search matches profile, facts, and events" {
    var store = try testStore();
    defer store.deinit();
    const vec = [_]f32{ 1, 0, 0 };
    _ = try store.saveMemory(.{
        .kind = .profile,
        .fact = "Keeps a journal",
        .model_name = "user",
    });
    _ = try store.saveMemory(.{
        .kind = .fact,
        .subject = "Maya",
        .fact = "Lives nearby",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });
    _ = try store.saveMemory(.{
        .kind = .event,
        .event = "Walked the creek",
        .occurred_at = "2026-08-28",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });

    var profile_out: [4096]u8 = undefined;
    const profile_json = try store.memorySearch("{\"query\":\"journal\"}", &profile_out);
    try std.testing.expect(std.mem.indexOf(u8, profile_json, "\"kind\":\"profile\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, profile_json, "Keeps a journal") != null);
    try std.testing.expect(std.mem.indexOf(u8, profile_json, "Lives nearby") == null);

    var fact_out: [4096]u8 = undefined;
    const fact_json = try store.memorySearch("{\"query\":\"nearby\"}", &fact_out);
    try std.testing.expect(std.mem.indexOf(u8, fact_json, "\"kind\":\"fact\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, fact_json, "\"subject\":\"Maya\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, fact_json, "Lives nearby") != null);

    var event_out: [4096]u8 = undefined;
    const event_json = try store.memorySearch("{\"query\":\"creek\"}", &event_out);
    try std.testing.expect(std.mem.indexOf(u8, event_json, "\"kind\":\"event\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, event_json, "Walked the creek") != null);
}

test "memory search matches a fact subject" {
    var store = try testStore();
    defer store.deinit();
    const vec = [_]f32{ 1, 0, 0 };
    _ = try store.saveMemory(.{
        .kind = .fact,
        .subject = "Maya",
        .fact = "Lives nearby",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });

    var output: [4096]u8 = undefined;
    const json = try store.memorySearch("{\"query\":\"Maya\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"kind\":\"fact\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"excerpt\":\"Lives nearby\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Lives nearby") != null);
}

test "memory search omits hidden rows" {
    var store = try testStore();
    defer store.deinit();
    const vec = [_]f32{ 1, 0, 0 };
    const facts = [_]NewFact{.{ .kind = "fact", .subject = "Maya", .fact = "Lives nearby", .embedding = &vec }};
    const events = [_]NewEvent{.{ .event = "Walked the creek", .occurred_at = "2026-08-28", .embedding = &vec }};
    _ = try store.commitDreamMemory(.entry, 1, &facts, &events, "nomic-embed-text:v1.5");
    try store.deleteMemory(.fact, 1);
    try store.deleteMemory(.event, 1);

    var output: [4096]u8 = undefined;
    try std.testing.expectEqualStrings("{\"hits\":[]}", try store.memorySearch("{\"query\":\"nearby\"}", &output));
    try std.testing.expectEqualStrings("{\"hits\":[]}", try store.memorySearch("{\"query\":\"creek\"}", &output));
}

test "memory search does not match sourceTitle or the You label" {
    var store = try testStore();
    defer store.deinit();
    const vec = [_]f32{ 1, 0, 0 };
    _ = try store.saveMemory(.{
        .kind = .profile,
        .fact = "Keeps a journal",
        .model_name = "user",
    });
    const facts = [_]NewFact{};
    const events = [_]NewEvent{.{ .event = "Walked the creek", .occurred_at = "2026-08-28", .embedding = &vec }};
    _ = try store.commitDreamMemory(.entry, 1, &facts, &events, "nomic-embed-text:v1.5");

    var output: [4096]u8 = undefined;
    try std.testing.expectEqualStrings("{\"hits\":[]}", try store.memorySearch("{\"query\":\"You\"}", &output));
    try std.testing.expectEqualStrings("{\"hits\":[]}", try store.memorySearch("{\"query\":\"Morning\"}", &output));
}

test "memory search returns no rows for a miss or empty query" {
    var store = try testStore();
    defer store.deinit();
    const vec = [_]f32{ 1, 0, 0 };
    _ = try store.saveMemory(.{
        .kind = .fact,
        .subject = "Maya",
        .fact = "Lives nearby",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });

    var output: [256]u8 = undefined;
    try std.testing.expectEqualStrings("{\"hits\":[]}", try store.memorySearch("{\"query\":\"zzz\"}", &output));
    try std.testing.expectEqualStrings("{\"hits\":[]}", try store.memorySearch("{\"query\":\"\"}", &output));
}

test "memory search keeps newest-first order and caps at 25" {
    var store = try testStore();
    defer store.deinit();
    const vec = [_]f32{ 1, 0, 0 };
    var i: usize = 0;
    while (i < 26) : (i += 1) {
        var fact_buf: [32]u8 = undefined;
        const fact = try std.fmt.bufPrint(&fact_buf, "fog item {d:0>2}", .{i});
        _ = try store.saveMemory(.{
            .kind = .fact,
            .subject = "Cap",
            .fact = fact,
            .embedding = &vec,
            .model_name = "nomic-embed-text:v1.5",
        });
    }

    var output: [16 * 1024]u8 = undefined;
    const json = try store.memorySearch("{\"query\":\"fog\"}", &output);
    try std.testing.expectEqual(@as(usize, 25), std.mem.count(u8, json, "\"kind\":\"fact\""));
    try std.testing.expect(std.mem.indexOf(u8, json, "fog item 00") == null);
    try std.testing.expect(std.mem.indexOf(u8, json, "fog item 25") != null);
    const newer = std.mem.indexOf(u8, json, "fog item 25") orelse return error.TestExpectedEqual;
    const older = std.mem.indexOf(u8, json, "fog item 01") orelse return error.TestExpectedEqual;
    try std.testing.expect(newer < older);
}

test "encrypted memory search matches ciphertext rows" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();
    const vec = [_]f32{ 1, 0, 0 };
    _ = try rig.store.saveMemory(.{
        .kind = .profile,
        .fact = "Keeps a journal",
        .model_name = "user",
    });
    _ = try rig.store.saveMemory(.{
        .kind = .fact,
        .subject = "Maya",
        .fact = "Lives nearby",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });
    _ = try rig.store.saveMemory(.{
        .kind = .event,
        .event = "Walked the creek",
        .occurred_at = "2026-08-28",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });

    var output: [4096]u8 = undefined;
    const json = try rig.store.memorySearch("{\"query\":\"nearby\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"kind\":\"fact\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Lives nearby") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Keeps a journal") == null);

    var event_out: [4096]u8 = undefined;
    const event_json = try rig.store.memorySearch("{\"query\":\"creek\"}", &event_out);
    try std.testing.expect(std.mem.indexOf(u8, event_json, "Walked the creek") != null);
}

test "loadConversationText keeps user and assistant text" {
    var store = try testStore();
    defer store.deinit();
    const insert = store.db.exec(&.{.{
        .sql = "INSERT INTO chat_conversation (title, eve_session_id, stream_index, events) VALUES (?1, NULL, 0, '');",
        .params = &.{.{ .text = "A talk" }},
    }});
    try std.testing.expect(insert == .ok);
    const user_event = "{\"type\":\"message.received\",\"data\":{\"message\":\"Hello Sage\",\"parts\":[{\"type\":\"text\",\"text\":\"Hello Sage\"}],\"turnId\":\"turn_0\"}}";
    const empty_event = "{\"type\":\"message.completed\",\"data\":{\"finishReason\":\"stop\",\"message\":null}}";
    const tool_event = "{\"type\":\"action.result\",\"data\":{\"status\":\"completed\"}}";
    const assistant_event = "{\"type\":\"message.completed\",\"data\":{\"finishReason\":\"stop\",\"message\":\"The fog lifted.\"}}";
    const events_insert = store.db.exec(&.{
        .{
            .sql = "INSERT INTO chat_event (conversation_id, seq, event) VALUES (1, 0, ?1);",
            .params = &.{.{ .text = user_event }},
        },
        .{
            .sql = "INSERT INTO chat_event (conversation_id, seq, event) VALUES (1, 1, ?1);",
            .params = &.{.{ .text = empty_event }},
        },
        .{
            .sql = "INSERT INTO chat_event (conversation_id, seq, event) VALUES (1, 2, ?1);",
            .params = &.{.{ .text = tool_event }},
        },
        .{
            .sql = "INSERT INTO chat_event (conversation_id, seq, event) VALUES (1, 3, ?1);",
            .params = &.{.{ .text = assistant_event }},
        },
    });
    try std.testing.expect(events_insert == .ok);

    const loaded = try store.loadConversationText(1);
    defer {
        store.allocator.free(loaded.date);
        store.allocator.free(loaded.text);
        store.allocator.free(loaded.recent);
    }
    try std.testing.expect(std.mem.indexOf(u8, loaded.text, "User: Hello Sage") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded.text, "Sage: The fog lifted.") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded.text, "action.result") == null);
    try std.testing.expect(std.mem.indexOf(u8, loaded.text, "completed") == null);
    try std.testing.expectEqualStrings(loaded.text, loaded.recent);
    try std.testing.expect(!loaded.title_locked);
}

test "loadConversationText recent keeps the last four messages" {
    var store = try testStore();
    defer store.deinit();
    const insert = store.db.exec(&.{.{
        .sql = "INSERT INTO chat_conversation (title, eve_session_id, stream_index, events) VALUES (?1, NULL, 0, '');",
        .params = &.{.{ .text = "A talk" }},
    }});
    try std.testing.expect(insert == .ok);
    const oldest = "{\"type\":\"message.received\",\"data\":{\"message\":\"Oldest\",\"turnId\":\"turn_0\"}}";
    const second = "{\"type\":\"message.received\",\"data\":{\"message\":\"Second\",\"turnId\":\"turn_1\"}}";
    const tool_event = "{\"type\":\"action.result\",\"data\":{\"status\":\"completed\"}}";
    const third = "{\"type\":\"message.received\",\"data\":{\"message\":\"Third\",\"turnId\":\"turn_2\"}}";
    const assistant_event = "{\"type\":\"message.completed\",\"data\":{\"finishReason\":\"stop\",\"message\":\"A reply.\"}}";
    const newest = "{\"type\":\"message.received\",\"data\":{\"message\":\"Newest\",\"turnId\":\"turn_3\"}}";
    const events_insert = store.db.exec(&.{
        .{
            .sql = "INSERT INTO chat_event (conversation_id, seq, event) VALUES (1, 0, ?1);",
            .params = &.{.{ .text = oldest }},
        },
        .{
            .sql = "INSERT INTO chat_event (conversation_id, seq, event) VALUES (1, 1, ?1);",
            .params = &.{.{ .text = second }},
        },
        .{
            .sql = "INSERT INTO chat_event (conversation_id, seq, event) VALUES (1, 2, ?1);",
            .params = &.{.{ .text = tool_event }},
        },
        .{
            .sql = "INSERT INTO chat_event (conversation_id, seq, event) VALUES (1, 3, ?1);",
            .params = &.{.{ .text = third }},
        },
        .{
            .sql = "INSERT INTO chat_event (conversation_id, seq, event) VALUES (1, 4, ?1);",
            .params = &.{.{ .text = assistant_event }},
        },
        .{
            .sql = "INSERT INTO chat_event (conversation_id, seq, event) VALUES (1, 5, ?1);",
            .params = &.{.{ .text = newest }},
        },
    });
    try std.testing.expect(events_insert == .ok);

    const loaded = try store.loadConversationText(1);
    defer {
        store.allocator.free(loaded.date);
        store.allocator.free(loaded.text);
        store.allocator.free(loaded.recent);
    }
    try std.testing.expect(std.mem.indexOf(u8, loaded.text, "User: Oldest") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded.recent, "User: Oldest") == null);
    try std.testing.expectEqualStrings(
        "User: Second\n\nUser: Third\n\nSage: A reply.\n\nUser: Newest",
        loaded.recent,
    );
    try std.testing.expect(std.mem.indexOf(u8, loaded.recent, "action.result") == null);
}

test "chat search matches user and assistant text" {
    var store = try testStore();
    defer store.deinit();
    const events =
        \\[{"type":"message.received","data":{"message":"Hello Sage","turnId":"turn_0"}},{"type":"message.completed","data":{"finishReason":"stop","message":null}},{"type":"action.result","data":{"status":"completed"}},{"type":"message.completed","data":{"finishReason":"stop","message":"The fog lifted."}}]
    ;
    _ = try saveChatEvents(&store, "A talk", events);

    var output: [8192]u8 = undefined;
    const user_json = try store.chatSearch("{\"query\":\"Hello Sage\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, user_json, "\"conversationId\":1") != null);
    try std.testing.expect(std.mem.indexOf(u8, user_json, "\"role\":\"user\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, user_json, "\"seq\":0") != null);
    try std.testing.expect(std.mem.indexOf(u8, user_json, "Hello Sage") != null);

    var assistant_out: [8192]u8 = undefined;
    const assistant_json = try store.chatSearch("{\"query\":\"fog\"}", &assistant_out);
    try std.testing.expect(std.mem.indexOf(u8, assistant_json, "\"role\":\"assistant\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, assistant_json, "\"seq\":3") != null);
    try std.testing.expect(std.mem.indexOf(u8, assistant_json, "The fog lifted.") != null);
    try std.testing.expect(std.mem.indexOf(u8, assistant_json, "action.result") == null);
}

test "home feed returns the latest entry and items in the date window" {
    var store = try testStore();
    defer store.deinit();
    var output: [16384]u8 = undefined;
    const json = try store.homeFeed("{\"sinceDate\":\"2026-08-18\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"title\":\"Quiet evening\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "The apartment was still") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"kind\":\"entry\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Morning walk") != null);
}

test "home feed keeps latest when items fall outside sinceDate" {
    var store = try testStore();
    defer store.deinit();
    var output: [8192]u8 = undefined;
    const json = try store.homeFeed("{\"sinceDate\":\"2026-09-01\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "Quiet evening") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"items\":[]") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Morning walk") == null);
}

test "home feed snippet is plaintext from tiptap" {
    var store = try testStore();
    defer store.deinit();
    var save_out: [8192]u8 = undefined;
    _ = try store.save(
        "{\"id\":null,\"title\":\"TipTap page\",\"date\":\"2026-09-10\",\"wordCount\":3,\"format\":\"tiptap\",\"offset\":0,\"chunk\":\"{\\\"type\\\":\\\"doc\\\",\\\"content\\\":[{\\\"type\\\":\\\"paragraph\\\",\\\"content\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"Hello from TipTap\\\"}]}]}\",\"done\":true}",
        &save_out,
    );
    var output: [8192]u8 = undefined;
    const json = try store.homeFeed("{\"sinceDate\":\"2026-09-01\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "Hello from TipTap") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\\\"type\\\":\\\"doc\\\"") == null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"type\":\"doc\"") == null);
}

test "home feed latest keeps markdown newlines" {
    var store = try testStore();
    defer store.deinit();
    var save_out: [8192]u8 = undefined;
    _ = try store.save(
        "{\"id\":null,\"title\":\"Markdown page\",\"date\":\"2026-09-20\",\"wordCount\":5,\"format\":\"markdown\",\"offset\":0,\"chunk\":\"# Hello\\n\\nThis is **bold** text.\",\"done\":true}",
        &save_out,
    );
    var output: [8192]u8 = undefined;
    const json = try store.homeFeed("{\"sinceDate\":\"2026-09-01\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"format\":\"markdown\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "**bold**") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\\n\\n") != null);
}

test "home feed uses the first assistant message" {
    var store = try testStore();
    defer store.deinit();
    const events =
        \\[{"type":"message.received","data":{"message":"Hello Sage","turnId":"turn_0"}},{"type":"message.completed","data":{"finishReason":"stop","message":null}},{"type":"message.completed","data":{"finishReason":"stop","message":"The fog lifted."}}]
    ;
    const id = try saveChatEvents(&store, "A talk", events);
    const stamp = store.db.exec(&.{.{
        .sql = "UPDATE chat_conversation SET updated_at = '2026-09-10T12:00:00.000Z' WHERE id = ?1;",
        .params = &.{.{ .integer = id }},
    }});
    try std.testing.expect(stamp == .ok);

    var output: [8192]u8 = undefined;
    const json = try store.homeFeed("{\"sinceDate\":\"2026-09-01\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"kind\":\"conversation\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "The fog lifted.") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Hello Sage") == null);
}

test "home feed omits conversations before sinceDate" {
    var store = try testStore();
    defer store.deinit();
    const events =
        \\[{"type":"message.completed","data":{"finishReason":"stop","message":"Old reply."}}]
    ;
    const id = try saveChatEvents(&store, "Old talk", events);
    const stamp = store.db.exec(&.{.{
        .sql = "UPDATE chat_conversation SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1;",
        .params = &.{.{ .integer = id }},
    }});
    try std.testing.expect(stamp == .ok);

    var output: [8192]u8 = undefined;
    const json = try store.homeFeed("{\"sinceDate\":\"2026-09-01\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "Old talk") == null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Old reply") == null);
}

test "home feed empty store has null latest" {
    var store = try testStore();
    defer store.deinit();
    var wipe: [256]u8 = undefined;
    _ = try store.deleteAllData(&wipe);
    var output: [256]u8 = undefined;
    const json = try store.homeFeed("{\"sinceDate\":\"2026-09-01\"}", &output);
    try std.testing.expectEqualStrings("{\"latest\":null,\"items\":[]}", json);
}

test "chat search matches a title when no message hits" {
    var store = try testStore();
    defer store.deinit();
    const events =
        \\[{"type":"message.received","data":{"message":"No overlap","turnId":"turn_0"}}]
    ;
    _ = try saveChatEvents(&store, "Zebra chat", events);

    var output: [8192]u8 = undefined;
    const json = try store.chatSearch("{\"query\":\"Zebra\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "Zebra chat") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"seq\":null") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"role\":null") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "No overlap") == null);
}

test "chat search returns no rows for a miss, empty query, or wildcard" {
    var store = try testStore();
    defer store.deinit();
    const events =
        \\[{"type":"message.received","data":{"message":"Hello Sage","turnId":"turn_0"}}]
    ;
    _ = try saveChatEvents(&store, "A talk", events);

    var output: [8192]u8 = undefined;
    try std.testing.expectEqualStrings("{\"hits\":[]}", try store.chatSearch("{\"query\":\"zzz\"}", &output));
    try std.testing.expectEqualStrings("{\"hits\":[]}", try store.chatSearch("{\"query\":\"\"}", &output));
    try std.testing.expectEqualStrings("{\"hits\":[]}", try store.chatSearch("{\"query\":\"%\"}", &output));
}

test "encrypted chat search matches ciphertext titles and events" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();
    const events =
        \\[{"type":"message.received","data":{"message":"A fog of my own.","turnId":"turn_0"}}]
    ;
    _ = try saveChatEvents(&rig.store, "Hidden chat", events);

    var output: [8192]u8 = undefined;
    const json = try rig.store.chatSearch("{\"query\":\"fog\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "Hidden chat") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "A fog of my own.") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"role\":\"user\"") != null);
}

test "chat search keeps the newest three message hits per conversation" {
    var store = try testStore();
    defer store.deinit();
    const busy =
        \\[{"type":"message.received","data":{"message":"fog 0","turnId":"t0"}},{"type":"message.received","data":{"message":"fog 1","turnId":"t1"}},{"type":"message.received","data":{"message":"fog 2","turnId":"t2"}},{"type":"message.received","data":{"message":"fog 3","turnId":"t3"}},{"type":"message.received","data":{"message":"fog 4","turnId":"t4"}}]
    ;
    _ = try saveChatEvents(&store, "Busy chat", busy);
    const other =
        \\[{"type":"message.received","data":{"message":"other fog","turnId":"t0"}}]
    ;
    _ = try saveChatEvents(&store, "Quiet chat", other);

    var output: [8192]u8 = undefined;
    const json = try store.chatSearch("{\"query\":\"fog\"}", &output);
    try std.testing.expect(std.mem.indexOf(u8, json, "Busy chat") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Quiet chat") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "fog 0") == null);
    try std.testing.expect(std.mem.indexOf(u8, json, "fog 1") == null);
    try std.testing.expect(std.mem.indexOf(u8, json, "fog 2") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "fog 4") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "other fog") != null);
}

test "replaceChatEmbeddings and listPendingChatEmbeddings" {
    var store = try testStore();
    defer store.deinit();
    const insert = store.db.exec(&.{.{
        .sql = "INSERT INTO chat_conversation (title, eve_session_id, stream_index, events) VALUES (?1, NULL, 0, '');",
        .params = &.{.{ .text = "A talk" }},
    }});
    try std.testing.expect(insert == .ok);
    var output: [256]u8 = undefined;
    try std.testing.expectEqualStrings("{\"ids\":[1]}", try store.listPendingChatEmbeddings(&output));
    const chunks = [_][]const u8{"hello"};
    const vec = [_]f32{ 0.1, 0.2, 0.3 };
    const vectors = [_][]const f32{&vec};
    try store.replaceChatEmbeddings(1, &chunks, &vectors, "nomic-embed-text:v1.5");
    try std.testing.expectEqualStrings("{\"ids\":[]}", try store.listPendingChatEmbeddings(&output));
}

test "deleteAllData wipes dreamed memory tables" {
    var store = try testStore();
    defer store.deinit();
    const vec = [_]f32{ 1, 0, 0 };
    const facts = [_]NewFact{.{ .kind = "profile", .subject = "user", .fact = "Keeps a journal", .embedding = null }};
    const events = [_]NewEvent{.{ .event = "Walked", .occurred_at = "2026-08-28", .embedding = &vec }};
    _ = try store.commitDreamMemory(.entry, 1, &facts, &events, "nomic-embed-text:v1.5");

    var wipe_out: [256]u8 = undefined;
    _ = try store.deleteAllData(&wipe_out);

    var profile_out: [256]u8 = undefined;
    var writer = std.Io.Writer.fixed(&profile_out);
    try store.listProfile(200, &writer);
    try std.testing.expectEqualStrings("{\"facts\":[]}", writer.buffered());
    const pending = try store.listPendingDream(false);
    defer store.allocator.free(pending);
    try std.testing.expectEqual(@as(usize, 0), pending.len);
}

test "splitJsonArrayElements reads objects and strings" {
    const items = try splitJsonArrayElements(std.testing.allocator, "[{\"type\":\"a\"}, \"x\", 2]");
    defer std.testing.allocator.free(items);
    try std.testing.expectEqual(@as(usize, 3), items.len);
    try std.testing.expectEqualStrings("{\"type\":\"a\"}", items[0]);
    try std.testing.expectEqualStrings("\"x\"", items[1]);
    try std.testing.expectEqualStrings("2", items[2]);
}

test "chat save get list and delete round-trip" {
    var store = try testStore();
    defer store.deinit();
    var output: [8192]u8 = undefined;
    const saved = try store.chatSave(
        "{\"id\":null,\"title\":\"What did I write?\",\"eveSessionId\":\"sess-1\",\"streamIndex\":3,\"model\":\"llama3.2\",\"thinking\":false,\"contextLength\":16384,\"baseSeq\":0,\"offset\":0,\"chunk\":\"[{\\\"type\\\":\\\"x\\\"}]\",\"done\":true}",
        &output,
    );
    try std.testing.expect(std.mem.indexOf(u8, saved, "\"id\":1") != null);

    var list_out: [8192]u8 = undefined;
    const listed = try store.chatList(&list_out);
    try std.testing.expect(std.mem.indexOf(u8, listed, "What did I write?") != null);
    try std.testing.expect(std.mem.indexOf(u8, listed, "\"id\":1") != null);

    var get_out: [8192]u8 = undefined;
    const loaded = try store.chatGet("{\"id\":1,\"offset\":0}", &get_out);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "What did I write?") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "sess-1") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"streamIndex\":3") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"model\":\"llama3.2\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"thinking\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"contextLength\":16384") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "[{\"type\":\"x\"}]") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"done\":true") != null);

    var delete_out: [256]u8 = undefined;
    var session_buf: [64]u8 = undefined;
    const deleted = try store.chatDelete("{\"id\":1}", &delete_out, &session_buf);
    try std.testing.expectEqualStrings("{\"ok\":true,\"eveSessionId\":\"sess-1\"}", deleted.json);
    try std.testing.expectEqualStrings("sess-1", deleted.session_id.?);
    var empty_out: [256]u8 = undefined;
    const empty = try store.chatList(&empty_out);
    try std.testing.expectEqualStrings("{\"conversations\":[]}", empty);
}

test "encrypted chat save stores ciphertext" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    const id = try saveChatEvents(&rig.store, "Private chat", "[{\"type\":\"x\"}]");

    var rows = ChatRows.init(std.testing.allocator);
    defer rows.deinit();
    const outcome = rig.store.db.query(
        "SELECT id, title, events FROM chat_conversation WHERE id = ?1;",
        &.{.{ .integer = id }},
        &rows,
        ChatRows.collect,
    );
    try std.testing.expect(outcome == .ok);
    try std.testing.expectEqual(@as(usize, 1), rows.rows.items.len);
    try std.testing.expect(vault_mod.Vault.isEncryptedField(rows.rows.items[0].title));
    try std.testing.expect(std.mem.indexOf(u8, rows.rows.items[0].title, "Private chat") == null);
    try std.testing.expectEqualStrings("", rows.rows.items[0].events);

    var event_rows = ChatEventRows.init(std.testing.allocator);
    defer event_rows.deinit();
    const event_outcome = rig.store.db.query(
        "SELECT seq, event FROM chat_event WHERE conversation_id = ?1;",
        &.{.{ .integer = id }},
        &event_rows,
        ChatEventRows.collect,
    );
    try std.testing.expect(event_outcome == .ok);
    try std.testing.expectEqual(@as(usize, 1), event_rows.rows.items.len);
    try std.testing.expect(vault_mod.Vault.isEncryptedField(event_rows.rows.items[0].event));
    try std.testing.expect(std.mem.indexOf(u8, event_rows.rows.items[0].event, "type") == null);

    var get_out: [8192]u8 = undefined;
    const loaded = try rig.store.chatGet("{\"id\":1,\"offset\":0}", &get_out);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "Private chat") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "[{\"type\":\"x\"}]") != null);
}

fn largeChatEvents(allocator: std.mem.Allocator, size: usize) ![]u8 {
    const payload_len: usize = 8000;
    var list: std.ArrayList(u8) = .empty;
    errdefer list.deinit(allocator);
    try list.append(allocator, '[');
    var first = true;
    while (list.items.len < size) {
        if (!first) try list.append(allocator, ',');
        first = false;
        try list.append(allocator, '"');
        var i: usize = 0;
        while (i < payload_len) : (i += 1) {
            try list.append(allocator, 'x');
        }
        try list.append(allocator, '"');
    }
    try list.append(allocator, ']');
    return list.toOwnedSlice(allocator);
}

fn saveChatEvents(store: *Store, title: []const u8, events: []const u8) !i64 {
    return saveChatEventsAt(store, null, title, 0, events);
}

fn saveChatEventsAt(store: *Store, id: ?i64, title: []const u8, base_seq: i64, events: []const u8) !i64 {
    var offset: usize = 0;
    var saved_id = id;
    while (true) {
        const chunk = utf8Chunk(events, offset, chunk_bytes);
        const done = offset + chunk.len >= events.len;
        var payload_buf: [20000]u8 = undefined;
        var writer = std.Io.Writer.fixed(&payload_buf);
        try writer.writeAll("{\"id\":");
        if (saved_id) |value| try writer.print("{d}", .{value}) else try writer.writeAll("null");
        try writer.writeAll(",\"title\":");
        try writeJsonString(&writer, title);
        try writer.writeAll(",\"eveSessionId\":null,\"streamIndex\":0,\"baseSeq\":");
        try writer.print("{d}", .{base_seq});
        try writer.writeAll(",\"offset\":");
        try writer.print("{d}", .{offset});
        try writer.writeAll(",\"chunk\":");
        try writeJsonString(&writer, chunk);
        try writer.writeAll(",\"done\":");
        try writer.writeAll(if (done) "true" else "false");
        try writer.writeByte('}');

        var out: [256]u8 = undefined;
        const saved = try store.chatSave(writer.buffered(), &out);
        if (responseId(saved)) |value| saved_id = value;
        if (done) return saved_id orelse error.TestUnexpectedResult;
        offset += chunk.len;
    }
}

fn responseId(saved: []const u8) ?i64 {
    if (jsonIsNull(saved, "id")) return null;
    return jsonI64(saved, "id");
}

fn chatTitleLockedValue(store: *Store, id: i64) !i64 {
    var rows = ChatRows.init(std.testing.allocator);
    defer rows.deinit();
    const outcome = store.db.query(
        "SELECT id, title_locked FROM chat_conversation WHERE id = ?1;",
        &.{.{ .integer = id }},
        &rows,
        ChatRows.collect,
    );
    try std.testing.expect(outcome == .ok);
    try std.testing.expectEqual(@as(usize, 1), rows.rows.items.len);
    return rows.rows.items[0].title_locked;
}

fn loadChatEvents(store: *Store, id: i64) ![]u8 {
    var events: std.ArrayList(u8) = .empty;
    errdefer events.deinit(std.testing.allocator);
    try events.append(std.testing.allocator, '[');
    var offset: i64 = 0;
    var first = true;
    while (true) {
        var payload_buf: [80]u8 = undefined;
        const payload = try std.fmt.bufPrint(&payload_buf, "{{\"id\":{d},\"offset\":{d}}}", .{ id, offset });
        var get_out: [1024 * 1024]u8 = undefined;
        const loaded = try store.chatGet(payload, &get_out);
        const raw = jsonRaw(loaded, "events") orelse return error.TestUnexpectedResult;
        if (raw.len < 2 or raw[0] != '[' or raw[raw.len - 1] != ']') return error.TestUnexpectedResult;
        const inner = std.mem.trim(u8, raw[1 .. raw.len - 1], " \n\r\t");
        if (inner.len > 0) {
            if (!first) try events.append(std.testing.allocator, ',');
            try events.appendSlice(std.testing.allocator, inner);
            first = false;
        }
        offset = jsonI64(loaded, "nextSeq") orelse return error.TestUnexpectedResult;
        if (jsonBool(loaded, "done") orelse return error.TestUnexpectedResult) break;
    }
    try events.append(std.testing.allocator, ']');
    return events.toOwnedSlice(std.testing.allocator);
}

test "chat get loads events larger than a query page" {
    var store = try testStore();
    defer store.deinit();

    const events = try largeChatEvents(std.testing.allocator, 300 * 1024);
    defer std.testing.allocator.free(events);
    const id = try saveChatEvents(&store, "Long tool chat", events);
    const loaded = try loadChatEvents(&store, id);
    defer std.testing.allocator.free(loaded);
    try std.testing.expectEqualStrings(events, loaded);
}

test "encrypted chat get loads events larger than a query page" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    const events = try largeChatEvents(std.testing.allocator, 300 * 1024);
    defer std.testing.allocator.free(events);
    const id = try saveChatEvents(&rig.store, "Long tool chat", events);
    const loaded = try loadChatEvents(&rig.store, id);
    defer std.testing.allocator.free(loaded);
    try std.testing.expectEqualStrings(events, loaded);
}

test "encrypted chat get pages a multi-megabyte transcript" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    // Real conversations with tool output pass the 1 MiB bridge response
    // cap, so paged reads by event range are the only way across.
    const events = try largeChatEvents(std.testing.allocator, 1536 * 1024);
    defer std.testing.allocator.free(events);
    const id = try saveChatEvents(&rig.store, "Long tool chat", events);
    const loaded = try loadChatEvents(&rig.store, id);
    defer std.testing.allocator.free(loaded);
    try std.testing.expectEqualStrings(events, loaded);
}

test "chat get serves fresh events after a save" {
    var store = try testStore();
    defer store.deinit();

    const id = try saveChatEvents(&store, "Chat", "[\"old\"]");
    const first = try loadChatEvents(&store, id);
    defer std.testing.allocator.free(first);
    try std.testing.expectEqualStrings("[\"old\"]", first);

    _ = try saveChatEventsAt(&store, id, "Chat", 0, "[\"new\"]");

    const second = try loadChatEvents(&store, id);
    defer std.testing.allocator.free(second);
    try std.testing.expectEqualStrings("[\"new\"]", second);
}

test "chat delete removes the conversation" {
    var store = try testStore();
    defer store.deinit();

    const id = try saveChatEvents(&store, "Chat", "[\"gone\"]");
    const first = try loadChatEvents(&store, id);
    defer std.testing.allocator.free(first);
    try std.testing.expectEqualStrings("[\"gone\"]", first);

    var payload_buf: [64]u8 = undefined;
    const payload = try std.fmt.bufPrint(&payload_buf, "{{\"id\":{d}}}", .{id});
    var out: [128]u8 = undefined;
    var session_buf: [64]u8 = undefined;
    const deleted = try store.chatDelete(payload, &out, &session_buf);
    try std.testing.expectEqualStrings("{\"ok\":true,\"eveSessionId\":null}", deleted.json);
    try std.testing.expect(deleted.session_id == null);

    var get_out: [1024]u8 = undefined;
    try std.testing.expectError(error.NotFound, store.chatGet(payload, &get_out));

    const missing = try store.chatDelete("{\"id\":999}", &out, &session_buf);
    try std.testing.expectEqualStrings("{\"ok\":true,\"eveSessionId\":null}", missing.json);
    try std.testing.expect(missing.session_id == null);
}

test "chat delete removes dreamed memories from that conversation" {
    var store = try testStore();
    defer store.deinit();
    const id = try saveChatEvents(&store, "Chat", "[\"gone\"]");
    const vec = [_]f32{ 1, 0, 0 };
    const facts = [_]NewFact{.{ .kind = "fact", .subject = "Maya", .fact = "Asked about the creek", .embedding = &vec }};
    const events = [_]NewEvent{.{ .event = "Talked it through", .occurred_at = "2026-08-28", .embedding = &vec }};
    _ = try store.commitDreamMemory(.conversation, id, &facts, &events, "nomic-embed-text:v1.5");
    _ = try store.saveMemory(.{
        .kind = .fact,
        .subject = "Sam",
        .fact = "Brought soup",
        .embedding = &vec,
        .model_name = "nomic-embed-text:v1.5",
    });
    try std.testing.expectEqual(@as(i64, 1), try countSourceFacts(&store, "conversation", id));
    try std.testing.expectEqual(@as(i64, 1), try countSourceEvents(&store, "conversation", id));

    var payload_buf: [64]u8 = undefined;
    const payload = try std.fmt.bufPrint(&payload_buf, "{{\"id\":{d}}}", .{id});
    var out: [128]u8 = undefined;
    var session_buf: [64]u8 = undefined;
    _ = try store.chatDelete(payload, &out, &session_buf);

    try std.testing.expectEqual(@as(i64, 0), try countSourceFacts(&store, "conversation", id));
    try std.testing.expectEqual(@as(i64, 0), try countSourceEvents(&store, "conversation", id));
    try std.testing.expectEqual(@as(i64, 0), try countSourceDreamState(&store, "conversation", id));
    var list_out: [4096]u8 = undefined;
    const json = try store.listMemories(&list_out);
    try std.testing.expect(std.mem.indexOf(u8, json, "Brought soup") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Asked about the creek") == null);
    try std.testing.expect(std.mem.indexOf(u8, json, "Talked it through") == null);
}

test "chatSessionIds lists stored run ids" {
    var store = try testStore();
    defer store.deinit();

    const empty = try store.chatSessionIds(std.testing.allocator);
    defer if (empty.len > 0) std.testing.allocator.free(empty);
    try std.testing.expectEqual(@as(usize, 0), empty.len);

    var output: [8192]u8 = undefined;
    _ = try store.chatSave(
        "{\"id\":null,\"title\":\"Kept\",\"eveSessionId\":\"wrun_01AAAAAAAAAAAAAAAAAAAAAAAA\",\"streamIndex\":0,\"model\":\"llama3.2\",\"thinking\":false,\"contextLength\":32768,\"baseSeq\":0,\"offset\":0,\"chunk\":\"[{\\\"type\\\":\\\"x\\\"}]\",\"done\":true}",
        &output,
    );
    _ = try saveChatEvents(&store, "No session", "[\"y\"]");

    const ids = try store.chatSessionIds(std.testing.allocator);
    defer {
        for (ids) |id| std.testing.allocator.free(id);
        std.testing.allocator.free(ids);
    }
    try std.testing.expectEqual(@as(usize, 1), ids.len);
    try std.testing.expectEqualStrings("wrun_01AAAAAAAAAAAAAAAAAAAAAAAA", ids[0]);
}

test "chatDelete session id removes that run's workflow files" {
    const eve_sidecar = @import("eve_sidecar.zig");
    var store = try testStore();
    defer store.deinit();
    const session = "wrun_01AAAAAAAAAAAAAAAAAAAAAAAA";

    var output: [8192]u8 = undefined;
    const saved = try store.chatSave(
        "{\"id\":null,\"title\":\"Gone\",\"eveSessionId\":\"wrun_01AAAAAAAAAAAAAAAAAAAAAAAA\",\"streamIndex\":0,\"model\":\"llama3.2\",\"thinking\":false,\"contextLength\":32768,\"baseSeq\":0,\"offset\":0,\"chunk\":\"[{\\\"type\\\":\\\"x\\\"}]\",\"done\":true}",
        &output,
    );
    const id = responseId(saved) orelse return error.TestUnexpectedResult;

    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var data_dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    try tmp.dir.writeFile(io, .{ .sub_path = ".keep", .data = "" });
    const keep_len = try tmp.dir.realPathFile(io, ".keep", &data_dir_buf);
    const data_dir = std.fs.path.dirname(data_dir_buf[0..keep_len]) orelse return error.InvalidPath;
    var root_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_buf, "{s}/eve/.eve/.workflow-data", .{data_dir});

    var run_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const run_path = try std.fmt.bufPrint(&run_buf, "{s}/runs/{s}.json", .{ root, session });
    if (std.fs.path.dirname(run_path)) |dir_path| {
        try std.Io.Dir.cwd().createDirPath(io, dir_path);
    }
    var run_file = try std.Io.Dir.createFileAbsolute(io, run_path, .{});
    try run_file.writeStreamingAll(io, "{\"runId\":\"x\"}");
    run_file.close(io);

    var attr_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const attr_path = try std.fmt.bufPrint(&attr_buf, "{s}/.locks/attributes/{s}-attr.created", .{ root, session });
    if (std.fs.path.dirname(attr_path)) |dir_path| {
        try std.Io.Dir.cwd().createDirPath(io, dir_path);
    }
    var attr_file = try std.Io.Dir.createFileAbsolute(io, attr_path, .{});
    try attr_file.writeStreamingAll(io, "");
    attr_file.close(io);

    var payload_buf: [64]u8 = undefined;
    const payload = try std.fmt.bufPrint(&payload_buf, "{{\"id\":{d}}}", .{id});
    var delete_out: [128]u8 = undefined;
    var session_buf: [64]u8 = undefined;
    const deleted = try store.chatDelete(payload, &delete_out, &session_buf);
    try std.testing.expectEqualStrings(session, deleted.session_id.?);

    eve_sidecar.deleteSessionData(io, data_dir, deleted.session_id.?);

    try std.testing.expect(!testAbsExists(io, run_path));
    try std.testing.expect(!testAbsExists(io, attr_path));
}

fn testAbsExists(io: std.Io, path: []const u8) bool {
    std.Io.Dir.accessAbsolute(io, path, .{}) catch return false;
    return true;
}

test "chat save updates model and thinking without moving the list" {
    var store = try testStore();
    defer store.deinit();

    const older_id = try saveChatEvents(&store, "Older", "[\"a\"]");
    _ = try saveChatEvents(&store, "Newer", "[\"b\"]");
    const stamp = store.db.exec(&.{.{
        .sql = "UPDATE chat_conversation SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1;",
        .params = &.{.{ .integer = older_id }},
    }});
    try std.testing.expect(stamp == .ok);

    var payload_buf: [320]u8 = undefined;
    const payload = try std.fmt.bufPrint(
        &payload_buf,
        "{{\"id\":{d},\"title\":\"Older\",\"eveSessionId\":null,\"streamIndex\":0,\"model\":\"qwen3:8b\",\"thinking\":true,\"baseSeq\":1,\"offset\":0,\"chunk\":\"[]\",\"done\":true}}",
        .{older_id},
    );
    var output: [256]u8 = undefined;
    _ = try store.chatSave(payload, &output);

    var get_payload_buf: [64]u8 = undefined;
    const get_payload = try std.fmt.bufPrint(&get_payload_buf, "{{\"id\":{d},\"offset\":0}}", .{older_id});
    var get_out: [8192]u8 = undefined;
    const loaded = try store.chatGet(get_payload, &get_out);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"model\":\"qwen3:8b\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"thinking\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "[\"a\"]") != null);

    var list_out: [8192]u8 = undefined;
    const listed = try store.chatList(&list_out);
    const newer = std.mem.indexOf(u8, listed, "Newer") orelse return error.TestUnexpectedResult;
    const older = std.mem.indexOf(u8, listed, "Older") orelse return error.TestUnexpectedResult;
    try std.testing.expect(newer < older);
}

test "chat savePrefs writes model and thinking without moving the list" {
    var store = try testStore();
    defer store.deinit();

    const older_id = try saveChatEvents(&store, "Older", "[\"a\"]");
    _ = try saveChatEvents(&store, "Newer", "[\"b\"]");
    const stamp = store.db.exec(&.{.{
        .sql = "UPDATE chat_conversation SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1;",
        .params = &.{.{ .integer = older_id }},
    }});
    try std.testing.expect(stamp == .ok);

    var payload_buf: [160]u8 = undefined;
    const payload = try std.fmt.bufPrint(
        &payload_buf,
        "{{\"id\":{d},\"model\":\"qwen3:8b\",\"thinking\":false}}",
        .{older_id},
    );
    var output: [64]u8 = undefined;
    const saved = try store.chatSavePrefs(payload, &output);
    try std.testing.expectEqualStrings("{\"ok\":true}", saved);

    var get_payload_buf: [64]u8 = undefined;
    const get_payload = try std.fmt.bufPrint(&get_payload_buf, "{{\"id\":{d},\"offset\":0}}", .{older_id});
    var get_out: [8192]u8 = undefined;
    const loaded = try store.chatGet(get_payload, &get_out);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"model\":\"qwen3:8b\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"thinking\":false") != null);

    var list_out: [8192]u8 = undefined;
    const listed = try store.chatList(&list_out);
    const newer = std.mem.indexOf(u8, listed, "Newer") orelse return error.TestUnexpectedResult;
    const older = std.mem.indexOf(u8, listed, "Older") orelse return error.TestUnexpectedResult;
    try std.testing.expect(newer < older);
}

test "chat rename writes title without moving the list" {
    var store = try testStore();
    defer store.deinit();

    const older_id = try saveChatEvents(&store, "Older", "[\"a\"]");
    _ = try saveChatEvents(&store, "Newer", "[\"b\"]");
    const stamp = store.db.exec(&.{.{
        .sql = "UPDATE chat_conversation SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1;",
        .params = &.{.{ .integer = older_id }},
    }});
    try std.testing.expect(stamp == .ok);

    var payload_buf: [160]u8 = undefined;
    const payload = try std.fmt.bufPrint(
        &payload_buf,
        "{{\"id\":{d},\"title\":\"Renamed older\"}}",
        .{older_id},
    );
    var output: [64]u8 = undefined;
    const renamed = try store.chatRename(payload, &output);
    try std.testing.expectEqualStrings("{\"ok\":true}", renamed);

    var get_payload_buf: [64]u8 = undefined;
    const get_payload = try std.fmt.bufPrint(&get_payload_buf, "{{\"id\":{d},\"offset\":0}}", .{older_id});
    var get_out: [8192]u8 = undefined;
    const loaded = try store.chatGet(get_payload, &get_out);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "Renamed older") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"title\":\"Older\"") == null);

    var list_out: [8192]u8 = undefined;
    const listed = try store.chatList(&list_out);
    try std.testing.expect(std.mem.indexOf(u8, listed, "Renamed older") != null);
    const newer = std.mem.indexOf(u8, listed, "Newer") orelse return error.TestUnexpectedResult;
    const older = std.mem.indexOf(u8, listed, "Renamed older") orelse return error.TestUnexpectedResult;
    try std.testing.expect(newer < older);

    var missing_out: [64]u8 = undefined;
    try std.testing.expectError(error.NotFound, store.chatRename("{\"id\":99,\"title\":\"Gone\"}", &missing_out));
}

test "chat save keeps a renamed title" {
    var store = try testStore();
    defer store.deinit();

    const id = try saveChatEvents(&store, "Original", "[\"a\"]");
    var rename_buf: [160]u8 = undefined;
    const rename_payload = try std.fmt.bufPrint(
        &rename_buf,
        "{{\"id\":{d},\"title\":\"Renamed\"}}",
        .{id},
    );
    var rename_out: [64]u8 = undefined;
    _ = try store.chatRename(rename_payload, &rename_out);

    _ = try saveChatEventsAt(&store, id, "Original", 1, "[\"b\"]");

    var get_payload_buf: [64]u8 = undefined;
    const get_payload = try std.fmt.bufPrint(&get_payload_buf, "{{\"id\":{d},\"offset\":0}}", .{id});
    var get_out: [8192]u8 = undefined;
    const loaded = try store.chatGet(get_payload, &get_out);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "Renamed") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"title\":\"Original\"") == null);
    const events = try loadChatEvents(&store, id);
    defer std.testing.allocator.free(events);
    try std.testing.expectEqualStrings("[\"a\",\"b\"]", events);
}

test "chat rename locks the title so Dream cannot overwrite it" {
    var store = try testStore();
    defer store.deinit();

    const older_id = try saveChatEvents(&store, "Older", "[\"a\"]");
    _ = try saveChatEvents(&store, "Newer", "[\"b\"]");
    const stamp = store.db.exec(&.{.{
        .sql = "UPDATE chat_conversation SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1;",
        .params = &.{.{ .integer = older_id }},
    }});
    try std.testing.expect(stamp == .ok);
    try std.testing.expectEqual(@as(i64, 0), try chatTitleLockedValue(&store, older_id));

    try store.applyDreamChatTitle(older_id, "Fog on the hill");
    try std.testing.expectEqual(@as(i64, 0), try chatTitleLockedValue(&store, older_id));

    var get_payload_buf: [64]u8 = undefined;
    var get_out: [8192]u8 = undefined;
    const dreamed = try store.chatGet(
        try std.fmt.bufPrint(&get_payload_buf, "{{\"id\":{d},\"offset\":0}}", .{older_id}),
        &get_out,
    );
    try std.testing.expect(std.mem.indexOf(u8, dreamed, "Fog on the hill") != null);

    var list_out: [8192]u8 = undefined;
    const listed = try store.chatList(&list_out);
    const newer = std.mem.indexOf(u8, listed, "Newer") orelse return error.TestUnexpectedResult;
    const older = std.mem.indexOf(u8, listed, "Fog on the hill") orelse return error.TestUnexpectedResult;
    try std.testing.expect(newer < older);

    var rename_buf: [160]u8 = undefined;
    var rename_out: [64]u8 = undefined;
    _ = try store.chatRename(
        try std.fmt.bufPrint(&rename_buf, "{{\"id\":{d},\"title\":\"Renamed older\"}}", .{older_id}),
        &rename_out,
    );
    try std.testing.expectEqual(@as(i64, 1), try chatTitleLockedValue(&store, older_id));

    try store.applyDreamChatTitle(older_id, "Should not stick");
    var locked_out: [8192]u8 = undefined;
    const locked = try store.chatGet(
        try std.fmt.bufPrint(&get_payload_buf, "{{\"id\":{d},\"offset\":0}}", .{older_id}),
        &locked_out,
    );
    try std.testing.expect(std.mem.indexOf(u8, locked, "Renamed older") != null);
    try std.testing.expect(std.mem.indexOf(u8, locked, "Should not stick") == null);
}

test "chat save of a missing conversation returns NotFound" {
    var store = try testStore();
    defer store.deinit();

    var out: [64]u8 = undefined;
    try std.testing.expectError(
        error.NotFound,
        store.chatSave(
            "{\"id\":99,\"title\":\"Gone\",\"eveSessionId\":null,\"streamIndex\":0,\"baseSeq\":0,\"offset\":0,\"chunk\":\"[]\",\"done\":true}",
            &out,
        ),
    );
}

test "encrypted chat rename stores ciphertext" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    const id = try saveChatEvents(&rig.store, "Private chat", "[{\"type\":\"x\"}]");
    var payload_buf: [160]u8 = undefined;
    const payload = try std.fmt.bufPrint(
        &payload_buf,
        "{{\"id\":{d},\"title\":\"Renamed private\"}}",
        .{id},
    );
    var output: [64]u8 = undefined;
    _ = try rig.store.chatRename(payload, &output);

    var rows = ChatRows.init(std.testing.allocator);
    defer rows.deinit();
    const outcome = rig.store.db.query(
        "SELECT id, title FROM chat_conversation WHERE id = ?1;",
        &.{.{ .integer = id }},
        &rows,
        ChatRows.collect,
    );
    try std.testing.expect(outcome == .ok);
    try std.testing.expectEqual(@as(usize, 1), rows.rows.items.len);
    try std.testing.expect(vault_mod.Vault.isEncryptedField(rows.rows.items[0].title));
    try std.testing.expect(std.mem.indexOf(u8, rows.rows.items[0].title, "Renamed private") == null);
    try std.testing.expect(std.mem.indexOf(u8, rows.rows.items[0].title, "Private chat") == null);

    var get_payload_buf: [64]u8 = undefined;
    const get_payload = try std.fmt.bufPrint(&get_payload_buf, "{{\"id\":{d},\"offset\":0}}", .{id});
    var get_out: [8192]u8 = undefined;
    const loaded = try rig.store.chatGet(get_payload, &get_out);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "Renamed private") != null);
}

test "chat get reports empty model prefs for older rows" {
    var store = try testStore();
    defer store.deinit();
    const id = try saveChatEvents(&store, "Legacy", "[\"a\"]");
    var payload_buf: [80]u8 = undefined;
    const payload = try std.fmt.bufPrint(&payload_buf, "{{\"id\":{d},\"offset\":0}}", .{id});
    var get_out: [8192]u8 = undefined;
    const loaded = try store.chatGet(payload, &get_out);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"model\":\"\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"thinking\":null") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"contextLength\":null") != null);
}

test "chat save snapshots context length and later saves keep it" {
    var store = try testStore();
    defer store.deinit();

    var create_out: [256]u8 = undefined;
    const created = try store.chatSave(
        "{\"id\":null,\"title\":\"Frozen\",\"eveSessionId\":null,\"streamIndex\":0,\"model\":\"llama3.2\",\"thinking\":true,\"contextLength\":32768,\"baseSeq\":0,\"offset\":0,\"chunk\":\"[\\\"a\\\"]\",\"done\":true}",
        &create_out,
    );
    const id = jsonI64(created, "id") orelse return error.TestUnexpectedResult;

    var update_buf: [384]u8 = undefined;
    const update = try std.fmt.bufPrint(
        &update_buf,
        "{{\"id\":{d},\"title\":\"Frozen\",\"eveSessionId\":null,\"streamIndex\":0,\"model\":\"qwen3:8b\",\"thinking\":false,\"contextLength\":65536,\"baseSeq\":1,\"offset\":0,\"chunk\":\"[]\",\"done\":true}}",
        .{id},
    );
    var update_out: [256]u8 = undefined;
    _ = try store.chatSave(update, &update_out);

    var get_buf: [64]u8 = undefined;
    const get_payload = try std.fmt.bufPrint(&get_buf, "{{\"id\":{d},\"offset\":0}}", .{id});
    var get_out: [8192]u8 = undefined;
    const loaded = try store.chatGet(get_payload, &get_out);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"contextLength\":32768") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"contextLength\":65536") == null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"model\":\"qwen3:8b\"") != null);
}

test "chat save fills a missing context length once and later saves keep it" {
    var store = try testStore();
    defer store.deinit();

    const id = try saveChatEvents(&store, "Legacy window", "[\"a\"]");
    var get_buf: [64]u8 = undefined;
    const missing_payload = try std.fmt.bufPrint(&get_buf, "{{\"id\":{d},\"offset\":0}}", .{id});
    var get_out: [8192]u8 = undefined;
    const missing = try store.chatGet(missing_payload, &get_out);
    try std.testing.expect(std.mem.indexOf(u8, missing, "\"contextLength\":null") != null);

    var fill_buf: [384]u8 = undefined;
    const fill = try std.fmt.bufPrint(
        &fill_buf,
        "{{\"id\":{d},\"title\":\"Legacy window\",\"eveSessionId\":null,\"streamIndex\":0,\"model\":\"llama3.2\",\"thinking\":true,\"contextLength\":32768,\"baseSeq\":1,\"offset\":0,\"chunk\":\"[]\",\"done\":true}}",
        .{id},
    );
    var fill_out: [256]u8 = undefined;
    _ = try store.chatSave(fill, &fill_out);

    var change_buf: [384]u8 = undefined;
    const change = try std.fmt.bufPrint(
        &change_buf,
        "{{\"id\":{d},\"title\":\"Legacy window\",\"eveSessionId\":null,\"streamIndex\":0,\"model\":\"qwen3:8b\",\"thinking\":false,\"contextLength\":65536,\"baseSeq\":1,\"offset\":0,\"chunk\":\"[]\",\"done\":true}}",
        .{id},
    );
    var change_out: [256]u8 = undefined;
    _ = try store.chatSave(change, &change_out);

    const loaded = try store.chatGet(missing_payload, &get_out);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"contextLength\":32768") != null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"contextLength\":65536") == null);
    try std.testing.expect(std.mem.indexOf(u8, loaded, "\"model\":\"qwen3:8b\"") != null);
}

test "chat save without new events keeps list order" {
    var store = try testStore();
    defer store.deinit();

    const older_id = try saveChatEvents(&store, "Older", "[\"a\"]");
    _ = try saveChatEvents(&store, "Newer", "[\"b\"]");
    const stamp = store.db.exec(&.{.{
        .sql = "UPDATE chat_conversation SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1;",
        .params = &.{.{ .integer = older_id }},
    }});
    try std.testing.expect(stamp == .ok);

    var list_out: [8192]u8 = undefined;
    const before = try store.chatList(&list_out);
    const newer_before = std.mem.indexOf(u8, before, "Newer") orelse return error.TestUnexpectedResult;
    const older_before = std.mem.indexOf(u8, before, "Older") orelse return error.TestUnexpectedResult;
    try std.testing.expect(newer_before < older_before);

    _ = try saveChatEventsAt(&store, older_id, "Older", 1, "[]");
    const after = try store.chatList(&list_out);
    const newer_after = std.mem.indexOf(u8, after, "Newer") orelse return error.TestUnexpectedResult;
    const older_after = std.mem.indexOf(u8, after, "Older") orelse return error.TestUnexpectedResult;
    try std.testing.expect(newer_after < older_after);

    _ = try saveChatEventsAt(&store, older_id, "Older", 1, "[\"c\"]");
    const moved = try store.chatList(&list_out);
    const older_moved = std.mem.indexOf(u8, moved, "Older") orelse return error.TestUnexpectedResult;
    const newer_moved = std.mem.indexOf(u8, moved, "Newer") orelse return error.TestUnexpectedResult;
    try std.testing.expect(older_moved < newer_moved);
}

test "chat save rewrites the tail from baseSeq" {
    var store = try testStore();
    defer store.deinit();

    const id = try saveChatEvents(&store, "Chat", "[\"s1\",\"c1\"]");
    _ = try saveChatEventsAt(&store, id, "Chat", 1, "[\"s2\",\"c1\"]");
    const loaded = try loadChatEvents(&store, id);
    defer std.testing.allocator.free(loaded);
    try std.testing.expectEqualStrings("[\"s1\",\"s2\",\"c1\"]", loaded);
}

test "chat save rejects a baseSeq past the end" {
    var store = try testStore();
    defer store.deinit();

    const id = try saveChatEvents(&store, "Chat", "[\"a\"]");
    var payload_buf: [256]u8 = undefined;
    const payload = try std.fmt.bufPrint(
        &payload_buf,
        "{{\"id\":{d},\"title\":\"Chat\",\"eveSessionId\":null,\"streamIndex\":0,\"baseSeq\":2,\"offset\":0,\"chunk\":\"[\\\"b\\\"]\",\"done\":true}}",
        .{id},
    );
    var out: [256]u8 = undefined;
    try std.testing.expectError(error.InvalidSaveChunk, store.chatSave(payload, &out));
}

test "chat save rejects an oversized event and stores nothing" {
    var store = try testStore();
    defer store.deinit();

    const oversized = try std.testing.allocator.alloc(u8, chat_event_max_plaintext_bytes + 1);
    defer std.testing.allocator.free(oversized);
    @memset(oversized, 'x');
    const events = try std.fmt.allocPrint(std.testing.allocator, "[\"{s}\"]", .{oversized});
    defer std.testing.allocator.free(events);

    try std.testing.expectError(error.ChatEventTooLarge, saveChatEvents(&store, "Big", events));

    var out: [256]u8 = undefined;
    const listed = try store.chatList(&out);
    try std.testing.expectEqualStrings("{\"conversations\":[]}", listed);
}

test "chat save rejects an oversized tail and keeps the stored events" {
    var store = try testStore();
    defer store.deinit();

    const id = try saveChatEvents(&store, "Chat", "[\"a\"]");
    const oversized = try std.testing.allocator.alloc(u8, chat_event_max_plaintext_bytes + 1);
    defer std.testing.allocator.free(oversized);
    @memset(oversized, 'x');
    const tail = try std.fmt.allocPrint(std.testing.allocator, "[\"{s}\"]", .{oversized});
    defer std.testing.allocator.free(tail);

    try std.testing.expectError(error.ChatEventTooLarge, saveChatEventsAt(&store, id, "Chat", 1, tail));

    const loaded = try loadChatEvents(&store, id);
    defer std.testing.allocator.free(loaded);
    try std.testing.expectEqualStrings("[\"a\"]", loaded);
}

test "chat save and get an event at the size cap" {
    var store = try testStore();
    defer store.deinit();

    // The element text is the quotes plus the content, so content two bytes
    // under the cap lands exactly on it.
    const content = try std.testing.allocator.alloc(u8, chat_event_max_plaintext_bytes - 2);
    defer std.testing.allocator.free(content);
    @memset(content, 'x');
    const events = try std.fmt.allocPrint(std.testing.allocator, "[\"{s}\"]", .{content});
    defer std.testing.allocator.free(events);

    const id = try saveChatEvents(&store, "Max", events);
    const loaded = try loadChatEvents(&store, id);
    defer std.testing.allocator.free(loaded);
    try std.testing.expectEqualStrings(events, loaded);
}

test "chat event ciphertext cannot move to another seq" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    const id = try saveChatEvents(&rig.store, "AAD", "[{\"n\":1},{\"n\":2}]");
    var event_rows = ChatEventRows.init(std.testing.allocator);
    defer event_rows.deinit();
    const selected = rig.store.db.query(
        "SELECT seq, event FROM chat_event WHERE conversation_id = ?1 AND seq = 0;",
        &.{.{ .integer = id }},
        &event_rows,
        ChatEventRows.collect,
    );
    try std.testing.expect(selected == .ok);
    try std.testing.expectEqual(@as(usize, 1), event_rows.rows.items.len);
    const copy = rig.store.db.exec(&.{.{
        .sql = "UPDATE chat_event SET event = ?1 WHERE conversation_id = ?2 AND seq = 1;",
        .params = &.{ .{ .text = event_rows.rows.items[0].event }, .{ .integer = id } },
    }});
    try std.testing.expect(copy == .ok);

    var get_out: [8192]u8 = undefined;
    const payload = try std.fmt.allocPrint(std.testing.allocator, "{{\"id\":{d},\"offset\":0}}", .{id});
    defer std.testing.allocator.free(payload);
    try std.testing.expectError(error.CorruptField, rig.store.chatGet(payload, &get_out));
}

test "chat save and get a transcript larger than 8 MiB" {
    var store = try testStore();
    defer store.deinit();

    const events = try largeChatEvents(std.testing.allocator, 9 * 1024 * 1024);
    defer std.testing.allocator.free(events);
    const id = try saveChatEvents(&store, "Huge tool chat", events);
    const loaded = try loadChatEvents(&store, id);
    defer std.testing.allocator.free(loaded);
    try std.testing.expectEqualStrings(events, loaded);
}

test "setRowsEncrypted rewrites a large chat" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    const events = try largeChatEvents(std.testing.allocator, 300 * 1024);
    defer std.testing.allocator.free(events);
    const id = try saveChatEvents(&rig.store, "Long tool chat", events);

    try rig.store.setRowsEncrypted(false);
    const after_off = try loadChatEvents(&rig.store, id);
    defer std.testing.allocator.free(after_off);
    try std.testing.expectEqualStrings(events, after_off);

    try rig.store.setRowsEncrypted(true);
    const after_on = try loadChatEvents(&rig.store, id);
    defer std.testing.allocator.free(after_on);
    try std.testing.expectEqualStrings(events, after_on);
}

fn largeJournalBody(allocator: std.mem.Allocator, size: usize) ![]u8 {
    const body = try allocator.alloc(u8, size);
    @memset(body, 'x');
    return body;
}

fn saveJournalBody(store: *Store, title: []const u8, body: []const u8) !i64 {
    var offset: usize = 0;
    while (true) {
        const chunk = utf8Chunk(body, offset, chunk_bytes);
        const done = offset + chunk.len >= body.len;
        var payload_buf: [20000]u8 = undefined;
        var writer = std.Io.Writer.fixed(&payload_buf);
        try writer.writeAll("{\"id\":null,\"title\":");
        try writeJsonString(&writer, title);
        try writer.writeAll(",\"date\":\"2026-09-07\",\"wordCount\":1,\"format\":\"markdown\",\"offset\":");
        try writer.print("{d}", .{offset});
        try writer.writeAll(",\"chunk\":");
        try writeJsonString(&writer, chunk);
        try writer.writeAll(",\"done\":");
        try writer.writeAll(if (done) "true" else "false");
        try writer.writeByte('}');

        var out: [256]u8 = undefined;
        const saved = try store.save(writer.buffered(), &out);
        if (done) return jsonI64(saved, "id") orelse error.TestUnexpectedResult;
        offset += chunk.len;
    }
}

fn loadJournalBody(store: *Store, id: i64) ![]u8 {
    var body: std.ArrayList(u8) = .empty;
    errdefer body.deinit(std.testing.allocator);
    var offset: usize = 0;
    while (true) {
        var payload_buf: [80]u8 = undefined;
        const payload = try std.fmt.bufPrint(&payload_buf, "{{\"id\":{d},\"offset\":{d}}}", .{ id, offset });
        var get_out: [1024 * 1024]u8 = undefined;
        const loaded = try store.get(payload, &get_out);
        var string_buf: [256 * 1024]u8 = undefined;
        var used: usize = 0;
        const chunk = jsonString(loaded, "chunk", &string_buf, &used) orelse return error.TestUnexpectedResult;
        try body.appendSlice(std.testing.allocator, chunk);
        offset += chunk.len;
        if (jsonBool(loaded, "done") orelse return error.TestUnexpectedResult) break;
    }
    return body.toOwnedSlice(std.testing.allocator);
}

test "get loads a journal body larger than a query page" {
    var store = try testStore();
    defer store.deinit();

    const body = try largeJournalBody(std.testing.allocator, 300 * 1024);
    defer std.testing.allocator.free(body);
    const id = try saveJournalBody(&store, "Long entry", body);
    const loaded = try loadJournalBody(&store, id);
    defer std.testing.allocator.free(loaded);
    try std.testing.expectEqualStrings(body, loaded);
}

test "encrypted get loads a journal body larger than a query page" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    const body = try largeJournalBody(std.testing.allocator, 300 * 1024);
    defer std.testing.allocator.free(body);
    const id = try saveJournalBody(&rig.store, "Long entry", body);
    const loaded = try loadJournalBody(&rig.store, id);
    defer std.testing.allocator.free(loaded);
    try std.testing.expectEqualStrings(body, loaded);
}

test "setRowsEncrypted rewrites a large journal body" {
    var rig: EncRig = undefined;
    try rig.init("correct horse");
    defer rig.deinit();

    const body = try largeJournalBody(std.testing.allocator, 300 * 1024);
    defer std.testing.allocator.free(body);
    const id = try saveJournalBody(&rig.store, "Long entry", body);

    try rig.store.setRowsEncrypted(false);
    const after_off = try loadJournalBody(&rig.store, id);
    defer std.testing.allocator.free(after_off);
    try std.testing.expectEqualStrings(body, after_off);

    try rig.store.setRowsEncrypted(true);
    const after_on = try loadJournalBody(&rig.store, id);
    defer std.testing.allocator.free(after_on);
    try std.testing.expectEqualStrings(body, after_on);
}
