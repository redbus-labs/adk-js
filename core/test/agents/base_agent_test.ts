/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlugin,
  Context,
  createSession,
  Event,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

class MockPlugin extends BasePlugin {
  constructor(name = 'mock') {
    super(name);
  }
  override async beforeAgentCallback(_params: {
    agent: BaseAgent;
    callbackContext: Context;
  }) {
    return undefined;
  }
  override async afterAgentCallback(_params: {
    agent: BaseAgent;
    callbackContext: Context;
  }) {
    return undefined;
  }
}

class MockBaseAgent extends BaseAgent {
  async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield {id: 'test-event'} as Event;
  }
  async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

describe('BaseAgent', () => {
  describe('Plugin callbacks', () => {
    it('should invoke plugin beforeAgentCallback and afterAgentCallback in runAsync', async () => {
      const plugin = new MockPlugin();
      const beforeSpy = vi.spyOn(plugin, 'beforeAgentCallback');
      const afterSpy = vi.spyOn(plugin, 'afterAgentCallback');

      const pluginManager = new PluginManager();
      pluginManager.registerPlugin(plugin);

      const agent = new MockBaseAgent({name: 'test_agent'});

      const invocationContext = new InvocationContext({
        invocationId: 'inv1',
        agent,
        session: createSession({
          id: 'session_1',
          appName: 'test',
          userId: 'user_1',
        }),
        pluginManager,
      });

      const generator = agent.runAsync(invocationContext);
      const events: Event[] = [];
      for await (const event of generator) {
        events.push(event);
      }

      expect(events.length).toBe(1);
      expect(beforeSpy).toHaveBeenCalledOnce();
      expect(afterSpy).toHaveBeenCalledOnce();
    });
  });

  describe('rootAgent', () => {
    it('should return the actual root agent for sub-agents', () => {
      const subAgent = new LlmAgent({
        name: 'sub_agent',
        description: 'A sub agent',
      });

      const rootAgent = new LlmAgent({
        name: 'root_agent',
        description: 'The root agent',
        subAgents: [subAgent],
      });

      expect(subAgent.rootAgent).toBe(rootAgent);
      expect(rootAgent.rootAgent).toBe(rootAgent);
    });

    it('should traverse multiple levels of nesting', () => {
      const leafAgent = new LlmAgent({name: 'leaf_agent'});
      const middleAgent = new LlmAgent({
        name: 'middle_agent',
        subAgents: [leafAgent],
      });
      const rootAgent = new LlmAgent({
        name: 'root_agent',
        subAgents: [middleAgent],
      });

      expect(leafAgent.rootAgent).toBe(rootAgent);
      expect(middleAgent.rootAgent).toBe(rootAgent);
      expect(rootAgent.rootAgent).toBe(rootAgent);
    });
  });
});
