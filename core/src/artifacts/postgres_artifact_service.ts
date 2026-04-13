/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createPartFromBase64, createPartFromText, Part} from '@google/genai';
import {PostgresConfig, PostgresHelper} from '../store/postgres_helper.js';
import {logger} from '../utils/logger.js';

import {
  ArtifactVersion,
  BaseArtifactService,
  DeleteArtifactRequest,
  ListArtifactKeysRequest,
  ListVersionsRequest,
  LoadArtifactRequest,
  SaveArtifactRequest,
} from './base_artifact_service.js';

/**
 * A PostgreSQL-backed implementation of the BaseArtifactService.
 *
 * Stores artifacts persistently in a PostgreSQL database with bytea storage.
 * Uses a single "artifacts" table per Node process for all artifact storage.
 * Multi-tenancy is achieved through (appName, userId, sessionId) isolation.
 *
 * Example usage with environment variables:
 * ```typescript
 * const artifactService = new PostgresArtifactService();
 * // Uses DBURL, DBUSER, DBPASSWORD environment variables
 * ```
 *
 * Example usage with explicit parameters:
 * ```typescript
 * const artifactService = new PostgresArtifactService({
 *   dbUrl: 'postgresql://localhost:5432/mydb',
 *   dbUser: 'user',
 *   dbPassword: 'pass'
 * });
 * ```
 */
export class PostgresArtifactService implements BaseArtifactService {
  private readonly dbHelper: PostgresHelper;
  private readonly tableName = 'artifacts';
  private initialized = false;

  /**
   * Creates a new PostgresArtifactService using environment variables or
   * explicit configuration. Uses the default "artifacts" table.
   */
  constructor(config?: PostgresConfig) {
    if (config) {
      this.dbHelper = PostgresHelper.createInstance(config, this.tableName);
    } else {
      this.dbHelper = PostgresHelper.getInstance(this.tableName);
    }
  }

  /**
   * Ensures the artifacts table is initialized.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.dbHelper.initializeArtifactsTable();
      this.initialized = true;
    }
  }

  /**
   * Extract buffer and MIME type from a Part object.
   */
  private extractDataFromPart(part: Part): {data: Buffer; mimeType: string} {
    if (part.inlineData) {
      const mimeType = part.inlineData.mimeType || 'application/octet-stream';
      const data = Buffer.from(part.inlineData.data || '', 'base64');
      return {data, mimeType};
    }

    if (part.text !== undefined && part.text !== null) {
      return {
        data: Buffer.from(part.text, 'utf-8'),
        mimeType: 'text/plain',
      };
    }

    throw new Error('Part does not contain inlineData or text content.');
  }

  async saveArtifact({
    appName,
    userId,
    sessionId,
    filename,
    artifact,
    customMetadata,
  }: SaveArtifactRequest): Promise<number> {
    await this.ensureInitialized();

    const {data, mimeType} = this.extractDataFromPart(artifact);
    const metadataJson = customMetadata ? JSON.stringify(customMetadata) : null;

    try {
      // Find the next version using COALESCE(MAX(version), -1) + 1 since ADK versions are 0-indexed
      const query = `
        INSERT INTO ${this.tableName} (app_name, user_id, session_id, filename, version, artifact_data, metadata, mime_type)
        VALUES (
          $1, $2, $3, $4,
          (SELECT COALESCE(MAX(version), -1) + 1 FROM ${this.tableName} WHERE app_name = $1 AND user_id = $2 AND session_id = $3 AND filename = $4),
          $5, $6::jsonb, $7
        )
        RETURNING version;
      `;

      const result = await this.dbHelper.query<{version: number}>(query, [
        appName,
        userId,
        sessionId,
        filename,
        data,
        metadataJson,
        mimeType,
      ]);

      const version = result.rows[0].version;
      logger.info(
        `Saved artifact ${filename} version ${version} to PostgreSQL`,
      );
      return version;
    } catch (error) {
      logger.error('Failed to save artifact', error);
      throw new Error(`Failed to save artifact: ${error}`);
    }
  }

  async loadArtifact({
    appName,
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<Part | undefined> {
    await this.ensureInitialized();

    try {
      let query: string;
      let params: unknown[];

      if (version === undefined) {
        // Get the latest version
        query = `
          SELECT artifact_data, mime_type
          FROM ${this.tableName}
          WHERE app_name = $1 AND user_id = $2 AND session_id = $3 AND filename = $4
          ORDER BY version DESC
          LIMIT 1
        `;
        params = [appName, userId, sessionId, filename];
      } else {
        query = `
          SELECT artifact_data, mime_type
          FROM ${this.tableName}
          WHERE app_name = $1 AND user_id = $2 AND session_id = $3 AND filename = $4 AND version = $5
        `;
        params = [appName, userId, sessionId, filename, version];
      }

      const result = await this.dbHelper.query<{
        artifact_data: Buffer;
        mime_type: string | null;
      }>(query, params);

      if (result.rows.length === 0) {
        return undefined;
      }

      const row = result.rows[0];
      const mimeType = row.mime_type || 'application/octet-stream';

      if (mimeType === 'text/plain') {
        return createPartFromText(row.artifact_data.toString('utf-8'));
      }

      return createPartFromBase64(
        row.artifact_data.toString('base64'),
        mimeType,
      );
    } catch (error) {
      logger.error('Failed to load artifact', error);
      throw new Error(`Failed to load artifact: ${error}`);
    }
  }

  async listArtifactKeys({
    appName,
    userId,
    sessionId,
  }: ListArtifactKeysRequest): Promise<string[]> {
    await this.ensureInitialized();

    try {
      const query = `
        SELECT DISTINCT filename
        FROM ${this.tableName}
        WHERE app_name = $1 AND user_id = $2 AND (session_id = $3 OR session_id = 'user')
        ORDER BY filename ASC
      `;

      const result = await this.dbHelper.query<{filename: string}>(query, [
        appName,
        userId,
        sessionId,
      ]);

      return result.rows.map((row) => row.filename);
    } catch (error) {
      logger.error('Failed to list artifacts', error);
      throw new Error(`Failed to list artifacts: ${error}`);
    }
  }

  async deleteArtifact({
    appName,
    userId,
    sessionId,
    filename,
  }: DeleteArtifactRequest): Promise<void> {
    await this.ensureInitialized();

    try {
      const query = `
        DELETE FROM ${this.tableName}
        WHERE app_name = $1 AND user_id = $2 AND session_id = $3 AND filename = $4
      `;

      await this.dbHelper.query(query, [appName, userId, sessionId, filename]);
      logger.info(`Deleted artifact ${filename} from PostgreSQL`);
    } catch (error) {
      logger.error('Failed to delete artifact', error);
      throw new Error(`Failed to delete artifact: ${error}`);
    }
  }

  async listVersions({
    appName,
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<number[]> {
    await this.ensureInitialized();

    try {
      const query = `
        SELECT version
        FROM ${this.tableName}
        WHERE app_name = $1 AND user_id = $2 AND session_id = $3 AND filename = $4
        ORDER BY version ASC
      `;

      const result = await this.dbHelper.query<{version: number}>(query, [
        appName,
        userId,
        sessionId,
        filename,
      ]);

      return result.rows.map((row) => row.version);
    } catch (error) {
      logger.error('Failed to list versions', error);
      throw new Error(`Failed to list versions: ${error}`);
    }
  }

  async listArtifactVersions({
    appName,
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<ArtifactVersion[]> {
    await this.ensureInitialized();

    try {
      const query = `
        SELECT version, metadata, mime_type
        FROM ${this.tableName}
        WHERE app_name = $1 AND user_id = $2 AND session_id = $3 AND filename = $4
        ORDER BY version ASC
      `;

      const result = await this.dbHelper.query<{
        version: number;
        metadata: unknown;
        mime_type: string | null;
      }>(query, [appName, userId, sessionId, filename]);

      return result.rows.map((row) => ({
        version: row.version,
        customMetadata: row.metadata
          ? typeof row.metadata === 'string'
            ? JSON.parse(row.metadata)
            : row.metadata
          : undefined,
        mimeType: row.mime_type || undefined,
      }));
    } catch (error) {
      logger.error('Failed to list artifact versions', error);
      throw new Error(`Failed to list artifact versions: ${error}`);
    }
  }

  async getArtifactVersion({
    appName,
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<ArtifactVersion | undefined> {
    await this.ensureInitialized();

    try {
      let query: string;
      let params: unknown[];

      if (version === undefined) {
        query = `
          SELECT version, metadata, mime_type
          FROM ${this.tableName}
          WHERE app_name = $1 AND user_id = $2 AND session_id = $3 AND filename = $4
          ORDER BY version DESC
          LIMIT 1
        `;
        params = [appName, userId, sessionId, filename];
      } else {
        query = `
          SELECT version, metadata, mime_type
          FROM ${this.tableName}
          WHERE app_name = $1 AND user_id = $2 AND session_id = $3 AND filename = $4 AND version = $5
        `;
        params = [appName, userId, sessionId, filename, version];
      }

      const result = await this.dbHelper.query<{
        version: number;
        metadata: unknown;
        mime_type: string | null;
      }>(query, params);

      if (result.rows.length === 0) {
        return undefined;
      }

      const row = result.rows[0];
      return {
        version: row.version,
        customMetadata: row.metadata
          ? typeof row.metadata === 'string'
            ? JSON.parse(row.metadata)
            : row.metadata
          : undefined,
        mimeType: row.mime_type || undefined,
      };
    } catch (error) {
      logger.error('Failed to get artifact version', error);
      throw new Error(`Failed to get artifact version: ${error}`);
    }
  }

  /**
   * Close the database connection pool.
   */
  async close(): Promise<void> {
    await this.dbHelper.close();
  }
}
