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
   * Ensures all tables are initialized.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.dbHelper.initializeSessionsTable('sessions');
      await this.dbHelper.initializeEventsTable('events');
      await this.dbHelper.initializeEventContentPartsTable('event_content_parts');
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

    // Use normalized schema: id as PK, event_data as summary
    const eventDataJson = {
      events: JSON.stringify(session.events)
    };

    const query = `
      INSERT INTO ${this.tableName} 
        (id, app_name, user_id, state, last_update_time, event_data)
      VALUES ($1, $2, $3, $4::jsonb, to_timestamp($5 / 1000.0), $6::jsonb)
      ON CONFLICT (id) 
      DO UPDATE SET 
        app_name = EXCLUDED.app_name,
        user_id = EXCLUDED.user_id,
        state = EXCLUDED.state,
        last_update_time = EXCLUDED.last_update_time,
        event_data = EXCLUDED.event_data
    `;

    try {
      await this.dbHelper.query(query, [
        session.id,
        appName,
        userId,
        JSON.stringify(session.state),
        session.lastUpdateTime,
        JSON.stringify(eventDataJson),
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

    // First, get the session metadata
    const sessionQuery = `
      SELECT id, app_name, user_id, state,
             EXTRACT(EPOCH FROM last_update_time) * 1000 as last_update_time
      FROM ${this.tableName}
      WHERE id = $1 AND app_name = $2 AND user_id = $3
    `;

    try {
      const sessionResult = await this.dbHelper.query<{
        id: string;
        app_name: string;
        user_id: string;
        state: any;
        last_update_time: number;
      }>(sessionQuery, [sessionId, appName, userId]);

      if (sessionResult.rows.length === 0) {
        return undefined;
      }

      const sessionRow = sessionResult.rows[0];
      const state = typeof sessionRow.state === 'string' 
        ? JSON.parse(sessionRow.state) 
        : sessionRow.state;

      // Now reconstruct events from normalized tables with JOIN
      const eventsQuery = `
        SELECT 
          e.id,
          e.session_id,
          e.author,
          e.actions_state_delta,
          e.actions_artifact_delta,
          e.actions_requested_auth_configs,
          e.actions_transfer_to_agent,
          e.content_role,
          e.timestamp,
          e.invocation_id,
          p.part_type,
          p.text_content,
          p.function_call_id,
          p.function_call_name,
          p.function_call_args,
          p.function_response_id,
          p.function_response_name,
          p.function_response_data
        FROM events e
        LEFT JOIN event_content_parts p ON e.id = p.event_id
        WHERE e.session_id = $1
        ORDER BY e.timestamp ASC
      `;

      const eventsResult = await this.dbHelper.query<{
        id: string;
        session_id: string;
        author: string | null;
        actions_state_delta: any;
        actions_artifact_delta: any;
        actions_requested_auth_configs: any;
        actions_transfer_to_agent: string | null;
        content_role: string | null;
        timestamp: number;
        invocation_id: string;
        part_type: string | null;
        text_content: string | null;
        function_call_id: string | null;
        function_call_name: string | null;
        function_call_args: any;
        function_response_id: string | null;
        function_response_name: string | null;
        function_response_data: any;
      }>(eventsQuery, [sessionId]);

      // Reconstruct Event objects from normalized data
      let events: Event[] = eventsResult.rows.map((row) => {
        // Reconstruct content part (only one part per event due to Java schema)
        const parts: any[] = [];
        
        if (row.part_type) {
          const part: any = {};
          
          if (row.part_type === 'text' && row.text_content) {
            part.text = row.text_content;
          } else if (row.part_type === 'functionCall') {
            part.functionCall = {
              id: row.function_call_id,
              name: row.function_call_name,
              args: row.function_call_args,
            };
          } else if (row.part_type === 'functionResponse') {
            part.functionResponse = {
              id: row.function_response_id,
              name: row.function_response_name,
              response: row.function_response_data,
            };
          }
          
          parts.push(part);
        }

        // Reconstruct event
        const event: Event = {
          id: row.id,
          invocationId: row.invocation_id,
          author: row.author || undefined,
          timestamp: row.timestamp,
          actions: {
            stateDelta: row.actions_state_delta || {},
            artifactDelta: row.actions_artifact_delta || {},
            requestedAuthConfigs: row.actions_requested_auth_configs || {},
            requestedToolConfirmations: {},
            transferToAgent: row.actions_transfer_to_agent || undefined,
          },
          content: parts.length > 0 ? {
            role: row.content_role || undefined,
            parts,
          } : undefined,
        };

        return event;
      });

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
        id: sessionRow.id,
        appName: sessionRow.app_name,
        userId: sessionRow.user_id,
        state,
        events,
        lastUpdateTime: sessionRow.last_update_time,
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
      SELECT id, app_name, user_id, 
             EXTRACT(EPOCH FROM last_update_time) * 1000 as last_update_time
      FROM ${this.tableName}
      WHERE app_name = $1 AND user_id = $2
      ORDER BY last_update_time DESC
    `;

    try {
      const result = await this.dbHelper.query<{
        id: string;
        app_name: string;
        user_id: string;
        last_update_time: number;
      }>(query, [appName, userId]);

      const sessions = result.rows.map((row) =>
        createSession({
          id: row.id,
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

    // Delete by session ID (CASCADE will handle events and parts)
    const query = `
      DELETE FROM ${this.tableName}
      WHERE id = $1
    `;

    try {
      await this.dbHelper.query(query, [sessionId]);
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

    // Use transaction to ensure atomicity across all 3 tables
    try {
      await this.dbHelper.withTransaction(async (client) => {
        // 1. Update sessions table with new state and event_data summary
        const eventDataJson = {
          events: JSON.stringify(session.events)
        };

        await client.query(
          `UPDATE ${this.tableName}
           SET state = $1::jsonb, 
               last_update_time = to_timestamp($2 / 1000.0),
               event_data = $3::jsonb
           WHERE id = $4`,
          [
            JSON.stringify(session.state),
            session.lastUpdateTime,
            JSON.stringify(eventDataJson),
            session.id,
          ]
        );

        // 2. Insert into events table
        await client.query(
          `INSERT INTO events (
             id, session_id, author, 
             actions_state_delta, actions_artifact_delta,
             actions_requested_auth_configs, actions_transfer_to_agent,
             content_role, timestamp, invocation_id
           ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10)
           ON CONFLICT (id) DO UPDATE SET
             session_id = EXCLUDED.session_id,
             author = EXCLUDED.author,
             actions_state_delta = EXCLUDED.actions_state_delta,
             actions_artifact_delta = EXCLUDED.actions_artifact_delta,
             actions_requested_auth_configs = EXCLUDED.actions_requested_auth_configs,
             actions_transfer_to_agent = EXCLUDED.actions_transfer_to_agent,
             content_role = EXCLUDED.content_role,
             timestamp = EXCLUDED.timestamp,
             invocation_id = EXCLUDED.invocation_id`,
          [
            event.id,
            session.id,
            event.author || null,
            JSON.stringify(event.actions.stateDelta || {}),
            JSON.stringify(event.actions.artifactDelta || {}),
            JSON.stringify(event.actions.requestedAuthConfigs || {}),
            event.actions.transferToAgent || null,
            event.content?.role || null,
            event.timestamp,
            event.invocationId,
          ]
        );

        // 3. Insert content parts into event_content_parts table
        // Note: Matches Java implementation which uses ON CONFLICT (event_id) DO UPDATE
        // This means only the last part is stored if there are multiple parts
        if (event.content?.parts && event.content.parts.length > 0) {
          for (const part of event.content.parts) {
            // Determine part type
            const partType = part.text !== undefined ? 'text'
              : part.functionCall ? 'functionCall'
              : part.functionResponse ? 'functionResponse'
              : 'unknown';

            await client.query(
              `INSERT INTO event_content_parts (
                 event_id, session_id, part_type,
                 text_content,
                 function_call_id, function_call_name, function_call_args,
                 function_response_id, function_response_name, function_response_data
               ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb)
               ON CONFLICT (event_id) DO UPDATE SET
                 session_id = EXCLUDED.session_id,
                 part_type = EXCLUDED.part_type,
                 text_content = EXCLUDED.text_content,
                 function_call_id = EXCLUDED.function_call_id,
                 function_call_name = EXCLUDED.function_call_name,
                 function_call_args = EXCLUDED.function_call_args,
                 function_response_id = EXCLUDED.function_response_id,
                 function_response_name = EXCLUDED.function_response_name,
                 function_response_data = EXCLUDED.function_response_data`,
              [
                event.id,
                session.id,
                partType,
                part.text || null,
                part.functionCall?.id || null,
                part.functionCall?.name || null,
                part.functionCall?.args ? JSON.stringify(part.functionCall.args) : null,
                part.functionResponse?.id || null,
                part.functionResponse?.name || null,
                part.functionResponse?.response ? JSON.stringify(part.functionResponse.response) : null,
              ]
            );
          }
        }
      });

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
