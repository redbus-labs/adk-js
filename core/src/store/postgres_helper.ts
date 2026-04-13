/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import pg from 'pg';

import {logger} from '../utils/logger.js';

const {Pool} = pg;

/**
 * PostgreSQL connection pool configuration interface.
 */
export interface PostgresConfig {
  /** Database connection URL (e.g., postgresql://localhost:5432/mydb) */
  dbUrl?: string;
  /** Database username */
  dbUser?: string;
  /** Database password */
  dbPassword?: string;
  /** Maximum number of clients in the pool */
  maxConnections?: number;
  /** Minimum number of idle clients */
  minConnections?: number;
  /** Connection timeout in milliseconds */
  connectionTimeout?: number;
  /** Idle timeout in milliseconds */
  idleTimeout?: number;
}

/**
 * PostgreSQL helper class managing connection pool and database operations.
 * Uses pg.Pool for efficient connection pooling (equivalent to HikariCP in Java).
 * Implements singleton pattern for process-wide connection management.
 *
 * Supports configuration via:
 * 1. Environment variables: DBURL, DBUSER, DBPASSWORD
 * 2. Explicit configuration object
 *
 * @example
 * // Using environment variables
 * const helper = PostgresHelper.getInstance();
 *
 * @example
 * // With explicit config
 * const helper = PostgresHelper.createInstance({
 *   dbUrl: 'postgresql://localhost:5432/mydb',
 *   dbUser: 'user',
 *   dbPassword: 'pass'
 * });
 */
export class PostgresHelper {
  private static instance: PostgresHelper | null = null;
  private pool: pg.Pool;
  private readonly tableName: string;

  /**
   * Private constructor for singleton pattern.
   */
  private constructor(config: PostgresConfig, tableName = 'artifacts') {
    this.tableName = tableName;
    this.pool = this.initializePool(config);
  }

  /**
   * Get singleton instance using environment variables.
   */
  public static getInstance(tableName = 'artifacts'): PostgresHelper {
    if (!PostgresHelper.instance) {
      const config = PostgresHelper.getConfigFromEnv();
      PostgresHelper.instance = new PostgresHelper(config, tableName);
    }
    return PostgresHelper.instance;
  }

  /**
   * Create a new instance with explicit configuration (non-singleton).
   */
  public static createInstance(
    config: PostgresConfig,
    tableName = 'artifacts'
  ): PostgresHelper {
    return new PostgresHelper(config, tableName);
  }

  /**
   * Get configuration from environment variables.
   */
  private static getConfigFromEnv(): PostgresConfig {
    const dbUrl = process.env.DBURL;
    const dbUser = process.env.DBUSER;
    const dbPassword = process.env.DBPASSWORD;

    if (!dbUrl) {
      throw new Error(
        'Database URL not configured. Set DBURL environment variable.'
      );
    }

    logger.info(
      `Database configuration loaded from environment for URL: ${dbUrl}`
    );

    return {
      dbUrl,
      dbUser,
      dbPassword,
    };
  }

  /**
   * Initialize connection pool with configuration.
   */
  private initializePool(config: PostgresConfig): pg.Pool {
    let connectionString = config.dbUrl || '';

    // If credentials are provided separately, build a proper connection string
    if (config.dbUser && config.dbPassword && !connectionString.includes('@')) {
      const urlParts = connectionString.replace('postgresql://', '').split('/');
      const hostPort = urlParts[0];
      const database = urlParts[1] || 'postgres';
      connectionString = `postgresql://${config.dbUser}:${config.dbPassword}@${hostPort}/${database}`;
    }

    const poolConfig: pg.PoolConfig = {
      connectionString,
      max: config.maxConnections || 10,
      min: config.minConnections || 2,
      connectionTimeoutMillis: config.connectionTimeout || 10000,
      idleTimeoutMillis: config.idleTimeout || 600000,
      // Allow connections to live for 30 minutes
      maxLifetimeSeconds: 1800,
    };

    const pool = new Pool(poolConfig);

    // Handle pool errors
    pool.on('error', (err) => {
      logger.error('Unexpected error on idle client', err);
    });

    // Log pool events
    pool.on('connect', () => {
      logger.debug('New client connected to PostgreSQL pool');
    });

    pool.on('remove', () => {
      logger.debug('Client removed from PostgreSQL pool');
    });

    logger.info('PostgreSQL connection pool initialized');

    return pool;
  }

  /**
   * Get a client from the connection pool.
   */
  public async getClient(): Promise<pg.PoolClient> {
    try {
      const client = await this.pool.connect();
      return client;
    } catch (error) {
      logger.error('Failed to get client from pool', error);
      throw new Error(`Database connection failed: ${error}`);
    }
  }

  /**
   * Execute a query with the connection pool.
   */
  public async query<T extends pg.QueryResultRow = any>(
    text: string,
    params?: any[]
  ): Promise<pg.QueryResult<T>> {
    try {
      return await this.pool.query<T>(text, params);
    } catch (error) {
      logger.error(`Query failed: ${text}`, error);
      throw new Error(`Query execution failed: ${error}`);
    }
  }

  /**
   * Initialize the artifacts table.
   */
  public async initializeArtifactsTable(): Promise<void> {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        app_name VARCHAR(255) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        session_id VARCHAR(255) NOT NULL,
        filename VARCHAR(255) NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        artifact_data BYTEA NOT NULL,
        metadata JSONB,
        mime_type VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (app_name, user_id, session_id, filename, version)
      )
    `;

    try {
      await this.query(createTableQuery);
      logger.info(`Artifacts table '${this.tableName}' initialized`);
    } catch (error) {
      logger.error('Failed to initialize artifacts table', error);
      throw error;
    }
  }

  /**
   * Initialize the sessions table (normalized schema).
   */
  public async initializeSessionsTable(
    tableName = 'sessions'
  ): Promise<void> {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id VARCHAR(255) PRIMARY KEY,
        app_name VARCHAR(255) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        state JSONB,
        last_update_time TIMESTAMP NOT NULL,
        event_data JSONB
      )
    `;

    try {
      await this.query(createTableQuery);
      logger.info(`Sessions table '${tableName}' initialized`);

      // Create index for faster queries
      const createIndexQuery = `
        CREATE INDEX IF NOT EXISTS idx_${tableName}_user_app 
        ON ${tableName} (user_id, app_name)
      `;
      await this.query(createIndexQuery);
    } catch (error) {
      logger.error('Failed to initialize sessions table', error);
      throw error;
    }
  }

  /**
   * Initialize the events table (normalized schema).
   */
  public async initializeEventsTable(tableName = 'events'): Promise<void> {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id VARCHAR(255) PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        author VARCHAR(255),
        actions_state_delta JSONB,
        actions_artifact_delta JSONB,
        actions_requested_auth_configs JSONB,
        actions_transfer_to_agent VARCHAR(255),
        content_role VARCHAR(50),
        timestamp BIGINT NOT NULL,
        invocation_id VARCHAR(255),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `;

    try {
      await this.query(createTableQuery);
      logger.info(`Events table '${tableName}' initialized`);

      // Create index for faster session event queries
      const createIndexQuery = `
        CREATE INDEX IF NOT EXISTS idx_${tableName}_session_timestamp 
        ON ${tableName} (session_id, timestamp)
      `;
      await this.query(createIndexQuery);
    } catch (error) {
      logger.error('Failed to initialize events table', error);
      throw error;
    }
  }

  /**
   * Initialize the event_content_parts table.
   * Multiple parts overwrite each other - storing only the last part.
   */
  public async initializeEventContentPartsTable(
    tableName = 'event_content_parts'
  ): Promise<void> {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS ${tableName} (
        event_id VARCHAR(255) PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        part_type VARCHAR(50) NOT NULL,
        text_content TEXT,
        function_call_id VARCHAR(255),
        function_call_name VARCHAR(255),
        function_call_args JSONB,
        function_response_id VARCHAR(255),
        function_response_name VARCHAR(255),
        function_response_data JSONB,
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      )
    `;

    try {
      await this.query(createTableQuery);
      logger.info(`Event content parts table '${tableName}' initialized`);

      // Create index for faster event parts queries
      const createIndexQuery = `
        CREATE INDEX IF NOT EXISTS idx_${tableName}_event 
        ON ${tableName} (event_id)
      `;
      await this.query(createIndexQuery);
    } catch (error) {
      logger.error('Failed to initialize event content parts table', error);
      throw error;
    }
  }

  /**
   * Get the table name.
   */
  public getTableName(): string {
    return this.tableName;
  }

  /**
   * Close the connection pool.
   */
  public async close(): Promise<void> {
    try {
      await this.pool.end();
      logger.info('PostgreSQL connection pool closed');
    } catch (error) {
      logger.error('Error closing connection pool', error);
      throw error;
    }
  }

  /**
   * Get pool statistics.
   */
  public getPoolStats() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }

  /**
   * Execute a function within a database transaction.
   * Automatically handles commit on success and rollback on error.
   * 
   * @param callback Function to execute within transaction
   * @returns Result of the callback function
   */
  public async withTransaction<T>(
    callback: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Transaction rolled back due to error', error);
      throw error;
    } finally {
      client.release();
    }
  }
}
