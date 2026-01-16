const path = require("path");
const { randomUUID } = require("crypto");
const Database = require("better-sqlite3");

const DEFAULT_DB_PATH = path.join(__dirname, "..", "freevox.sqlite");

let db;

function initDb({ dbPath } = {}) {
	if (db) {
		return db;
	}
	const resolvedPath = dbPath || process.env.FREEVOX_DB_PATH || DEFAULT_DB_PATH;
	db = new Database(resolvedPath);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	ensureSchema(db);
	return db;
}

function getUserId() {
	const userId = process.env.FREEVOX_USER_ID;
	if (!userId) {
		throw new Error("Missing FREEVOX_USER_ID in environment.");
	}
	return userId;
}

function ensureSchema(database) {
	database.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS conversations (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			title TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		);
		CREATE TABLE IF NOT EXISTS messages (
			id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL,
			FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
		);
		CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages(conversation_id);
	`);
}

function ensureUser(userId) {
	const database = initDb();
	const now = new Date().toISOString();
	database
		.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)")
		.run(userId, now);
}

function requireConversation({ conversationId, userId }) {
	if (!conversationId) {
		throw new Error("conversationId is required.");
	}
	const database = initDb();
	const row = database
		.prepare("SELECT id FROM conversations WHERE id = ? AND user_id = ?")
		.get(conversationId, userId);
	if (!row) {
		throw new Error("Conversation not found.");
	}
	return row;
}

function createConversation({ title, userId } = {}) {
	const database = initDb();
	const resolvedUserId = userId || getUserId();
	ensureUser(resolvedUserId);
	const id = randomUUID();
	const now = new Date().toISOString();
	const finalTitle = title || "New conversation";
	database
		.prepare(
			"INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
		)
		.run(id, resolvedUserId, finalTitle, now, now);
	return {
		id,
		user_id: resolvedUserId,
		title: finalTitle,
		created_at: now,
		updated_at: now
	};
}

function listConversations({ userId } = {}) {
	const database = initDb();
	const resolvedUserId = userId || getUserId();
	ensureUser(resolvedUserId);
	return database
		.prepare(
			"SELECT id, user_id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC"
		)
		.all(resolvedUserId);
}

function getConversation({ conversationId, userId } = {}) {
	const database = initDb();
	const resolvedUserId = userId || getUserId();
	if (!conversationId) {
		throw new Error("conversationId is required.");
	}
	return database
		.prepare(
			"SELECT id, user_id, title, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?"
		)
		.get(conversationId, resolvedUserId);
}

function updateConversationTitle({ conversationId, title, userId } = {}) {
	if (!title) {
		throw new Error("title is required.");
	}
	const database = initDb();
	const resolvedUserId = userId || getUserId();
	requireConversation({ conversationId, userId: resolvedUserId });
	const now = new Date().toISOString();
	database
		.prepare(
			"UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?"
		)
		.run(title, now, conversationId, resolvedUserId);
	return getConversation({ conversationId, userId: resolvedUserId });
}

function deleteConversation({ conversationId, userId } = {}) {
	const database = initDb();
	const resolvedUserId = userId || getUserId();
	const transaction = database.transaction(() => {
		const existing = database
			.prepare("SELECT id FROM conversations WHERE id = ? AND user_id = ?")
			.get(conversationId, resolvedUserId);
		if (!existing) {
			return { deleted: false };
		}
		database.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
		database
			.prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?")
			.run(conversationId, resolvedUserId);
		return { deleted: true };
	});
	return transaction();
}

function addMessage({ conversationId, role, content, userId } = {}) {
	if (!role) {
		throw new Error("role is required.");
	}
	if (content === undefined || content === null) {
		throw new Error("content is required.");
	}
	const database = initDb();
	const resolvedUserId = userId || getUserId();
	requireConversation({ conversationId, userId: resolvedUserId });
	const id = randomUUID();
	const now = new Date().toISOString();
	const transaction = database.transaction(() => {
		database
			.prepare(
				"INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
			)
			.run(id, conversationId, role, content, now);
		database
			.prepare("UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?")
			.run(now, conversationId, resolvedUserId);
	});
	transaction();
	return {
		id,
		conversation_id: conversationId,
		role,
		content,
		created_at: now
	};
}

function listMessages({ conversationId, userId } = {}) {
	const database = initDb();
	const resolvedUserId = userId || getUserId();
	requireConversation({ conversationId, userId: resolvedUserId });
	return database
		.prepare(
			"SELECT id, conversation_id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
		)
		.all(conversationId);
}

module.exports = {
	initDb,
	getUserId,
	createConversation,
	listConversations,
	getConversation,
	updateConversationTitle,
	deleteConversation,
	addMessage,
	listMessages
};
