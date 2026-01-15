/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent} from '../agents/base_agent.js';
import {PostgresArtifactService} from '../artifacts/postgres_artifact_service.js';
import {BaseMemoryService} from '../memory/base_memory_service.js';
import {InMemoryMemoryService} from '../memory/in_memory_memory_service.js';
import {BasePlugin} from '../plugins/base_plugin.js';
import {PostgresSessionService} from '../sessions/postgres_session_service.js';

import {Runner} from './runner.js';

/**
 * PostgreSQL-backed Runner implementation.
 *
 * Uses PostgreSQL for persistent session and artifact storage.
 * Falls back to InMemoryMemoryService for memory (can be overridden).
 *
 * Configuration via environment variables:
 * - DBURL: PostgreSQL connection URL (e.g., postgresql://localhost:5432/mydb)
 * - DBUSER: Database username
 * - DBPASSWORD: Database password
 *
 * @example
 * // Using environment variables
 * const runner = new PostgresRunner({
 *   agent: myAgent,
 *   appName: 'my-app'
 * });
 *
 * @example
 * // With custom memory service
 * const runner = new PostgresRunner({
 *   agent: myAgent,
 *   appName: 'my-app',
 *   memoryService: customMemoryService
 * });
 *
 * @example
 * // With explicit database config
 * const runner = new PostgresRunner({
 *   agent: myAgent,
 *   appName: 'my-app',
 *   dbConfig: {
 *     dbUrl: 'postgresql://localhost:5432/mydb',
 *     dbUser: 'user',
 *     dbPassword: 'pass'
 *   }
 * });
 */
export class PostgresRunner extends Runner {
  constructor({
    agent,
    appName,
    memoryService,
    plugins = [],
    dbConfig,
  }: {
    agent: BaseAgent;
    appName?: string;
    memoryService?: BaseMemoryService;
    plugins?: BasePlugin[];
    dbConfig?: {
      dbUrl?: string;
      dbUser?: string;
      dbPassword?: string;
    };
  }) {
    super({
      appName: appName || agent.name,
      agent,
      plugins,
      artifactService: new PostgresArtifactService(dbConfig),
      sessionService: new PostgresSessionService(dbConfig),
      memoryService: memoryService || new InMemoryMemoryService(),
    });
  }
}
