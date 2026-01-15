/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';
import {PostgresHelper} from '../store/postgres_helper.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';

import {
  AppendEventRequest,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
} from './base_session_service.js';
import {createSession, Session} from './session.js';
import {State} from './state.js';

/**
 * PostgreSQL-backed implementation of the session service.
 *
 * Stores sessions persistently in PostgreSQL with JSONB for state and events.
 * Supports environment variable configuration or explicit connection parameters.
 *
 * Example usage with environment variables:
 * ```typescript
 * const sessionService = new PostgresSessionService();
 * // Uses DBURL, DBUSER, DBPASSWORD environment variables
 * ```
 *
 * Example usage with explicit parameters:
 * ```typescript
 * const sessionService = new PostgresSessionService({
 *   dbUrl: 'postgresql://localhost:5432/mydb',
 *   dbUser: 'user',
 *   dbPassword: 'pass'
 * });
 * ```
 */
export class PostgresSessionService extends BaseSessionService {
  private readonly dbHelper: PostgresHelper;
  private readonly tableName = 'sessions';
  private initialized = false;

  /**
   * Creates a new PostgresSessionService using environment variables or
   * explicit configuration.
   */
  constructor(config?: {
    dbUrl?: string;
    dbUser?: string;
    dbPassword?: string;
  }) {
    super();
    if (config) {
      this.dbHelper = PostgresHelper.createInstance(config, this.tableName);
    } else {
      this.dbHelper = PostgresHelper.getInstance(this.tableName);
    }
  }

  /**
   * Ensures the sessions table is initialized.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.dbHelper.initializeSessionsTable(this.tableName);
      this.initialized = true;
    }
  }

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    await this.ensureInitialized();

    const session = createSession({
      id: sessionId || randomUUID(),
      appName,
      userId,
      state: state || {},
      events: [],
      lastUpdateTime: Date.now(),
    });

    const query = `
      INSERT INTO ${this.tableName} 
        (app_name, user_id, session_id, state, events, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0))
      ON CONFLICT (app_name, user_id, session_id) 
      DO UPDATE SET 
        state = EXCLUDED.state,
        events = EXCLUDED.events,
        updated_at = EXCLUDED.updated_at
    `;

    try {
      await this.dbHelper.query(query, [
        appName,
        userId,
        session.id,
        JSON.stringify(session.state),
        JSON.stringify(session.events),
        session.lastUpdateTime,
        session.lastUpdateTime,
      ]);

      logger.info(`Created session ${session.id} for user ${userId}`);
      return session;
    } catch (error) {
      logger.error('Failed to create session', error);
      throw new Error(`Failed to create session: ${error}`);
    }
  }

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    await this.ensureInitialized();

    const query = `
      SELECT session_id, app_name, user_id, state, events, 
             EXTRACT(EPOCH FROM updated_at) * 1000 as last_update_time
      FROM ${this.tableName}
      WHERE app_name = $1 AND user_id = $2 AND session_id = $3
    `;

    try {
      const result = await this.dbHelper.query<{
        session_id: string;
        app_name: string;
        user_id: string;
        state: any; // JSONB returns as object, not string
        events: any; // JSONB returns as object, not string
        last_update_time: number;
      }>(query, [appName, userId, sessionId]);

      if (result.rows.length === 0) {
        return undefined;
      }

      const row = result.rows[0];
      // PostgreSQL JSONB fields are already parsed as objects
      let events: Event[] = typeof row.events === 'string' 
        ? JSON.parse(row.events) 
        : row.events;
      const state = typeof row.state === 'string' 
        ? JSON.parse(row.state) 
        : row.state;

      // Apply config filters if provided
      if (config) {
        if (config.numRecentEvents) {
          events = events.slice(-config.numRecentEvents);
        }
        if (config.afterTimestamp) {
          events = events.filter((event) => event.timestamp >= config.afterTimestamp!);
        }
      }

      const session = createSession({
        id: row.session_id,
        appName: row.app_name,
        userId: row.user_id,
        state,
        events,
        lastUpdateTime: row.last_update_time,
      });

      return session;
    } catch (error) {
      logger.error('Failed to get session', error);
      throw new Error(`Failed to get session: ${error}`);
    }
  }

  async listSessions({
    appName,
    userId,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    await this.ensureInitialized();

    const query = `
      SELECT session_id, app_name, user_id, 
             EXTRACT(EPOCH FROM updated_at) * 1000 as last_update_time
      FROM ${this.tableName}
      WHERE app_name = $1 AND user_id = $2
      ORDER BY updated_at DESC
    `;

    try {
      const result = await this.dbHelper.query<{
        session_id: string;
        app_name: string;
        user_id: string;
        last_update_time: number;
      }>(query, [appName, userId]);

      const sessions = result.rows.map((row) =>
        createSession({
          id: row.session_id,
          appName: row.app_name,
          userId: row.user_id,
          state: {},
          events: [],
          lastUpdateTime: row.last_update_time,
        })
      );

      return {sessions};
    } catch (error) {
      logger.error('Failed to list sessions', error);
      throw new Error(`Failed to list sessions: ${error}`);
    }
  }

  async deleteSession({
    appName,
    userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    await this.ensureInitialized();

    const query = `
      DELETE FROM ${this.tableName}
      WHERE app_name = $1 AND user_id = $2 AND session_id = $3
    `;

    try {
      await this.dbHelper.query(query, [appName, userId, sessionId]);
      logger.info(`Deleted session ${sessionId} for user ${userId}`);
    } catch (error) {
      logger.error('Failed to delete session', error);
      throw new Error(`Failed to delete session: ${error}`);
    }
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    await this.ensureInitialized();

    // Call parent to update session state and events array
    await super.appendEvent({session, event});
    session.lastUpdateTime = event.timestamp;

    // Persist to database
    const query = `
      UPDATE ${this.tableName}
      SET state = $1, events = $2, updated_at = to_timestamp($3 / 1000.0)
      WHERE app_name = $4 AND user_id = $5 AND session_id = $6
    `;

    try {
      await this.dbHelper.query(query, [
        JSON.stringify(session.state),
        JSON.stringify(session.events),
        session.lastUpdateTime,
        session.appName,
        session.userId,
        session.id,
      ]);

      logger.debug(
        `Appended event to session ${session.id}, total events: ${session.events.length}`
      );
      return event;
    } catch (error) {
      logger.error('Failed to append event', error);
      throw new Error(`Failed to append event: ${error}`);
    }
  }

  /**
   * Close the database connection pool.
   */
  async close(): Promise<void> {
    await this.dbHelper.close();
  }
}
