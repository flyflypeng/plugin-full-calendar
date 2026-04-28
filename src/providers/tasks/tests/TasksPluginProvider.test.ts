/**
 * @file TasksPluginProvider.test.ts
 * @brief Unit tests for TasksPluginProvider functionality.
 *
 * @license See LICENSE.md
 */

import { TasksPluginProvider } from '../TasksPluginProvider';
import { TasksProviderConfig } from '../typesTask';
import type { OFCEvent } from '../../../types/schema';
import type { ObsidianInterface } from '../../../ObsidianAdapter';
import type FullCalendarPlugin from '../../../main';

// Mock the dependencies
jest.mock('../../../ObsidianAdapter');
// NOTE: NOT mocking TasksParser so we can test the real enhanced parsing functionality

type MockApp = {
  read: jest.Mock;
  getAbstractFileByPath: jest.Mock;
  getFileByPath: jest.Mock;
  getMetadata: jest.Mock;
  create: jest.Mock;
  rewrite: jest.Mock;
  delete: jest.Mock;
};

type MockPlugin = {
  app: {
    vault: { getMarkdownFiles: jest.Mock };
    workspace: { trigger: jest.Mock };
  };
  settings: Record<string, unknown>;
  cache: {
    syncCalendar: jest.Mock;
  };
  providerRegistry: {
    refreshBacklogViews: jest.Mock;
  };
};

type MockTasksDate = {
  toDate: () => Date;
};

type MockTasksTask = {
  path: string;
  description: string;
  taskLocation: { lineNumber: number };
  startDate?: MockTasksDate;
  dueDate?: MockTasksDate;
  scheduledDate?: MockTasksDate;
  originalMarkdown: string;
  isDone?: boolean;
};

const taskDate = (isoDate: string): MockTasksDate => ({
  toDate: () => new Date(`${isoDate}T00:00:00`)
});

const createTask = (overrides: Partial<MockTasksTask> = {}): MockTasksTask => ({
  path: 'tasks.md',
  description: 'Test task',
  taskLocation: { lineNumber: 0 },
  originalMarkdown: '- [ ] Test task',
  isDone: false,
  ...overrides
});

describe('TasksPluginProvider', () => {
  let provider: TasksPluginProvider;
  let mockApp: MockApp;
  let mockPlugin: MockPlugin;

  beforeEach(() => {
    // Mock ObsidianInterface
    mockApp = {
      read: jest.fn(),
      getAbstractFileByPath: jest.fn(),
      getFileByPath: jest.fn(),
      getMetadata: jest.fn(),
      create: jest.fn(),
      rewrite: jest.fn(),
      delete: jest.fn()
    };

    // Mock FullCalendarPlugin
    mockPlugin = {
      app: {
        vault: {
          getMarkdownFiles: jest.fn().mockReturnValue([])
        },
        workspace: {
          trigger: jest.fn((eventName: string, callback: (data: unknown) => void) => {
            if (eventName === 'obsidian-tasks-plugin:request-cache-update') {
              callback({ state: 'Warm', tasks: [] }); // MODIFIED: resolves cache warm promise
            }
          })
        }
      },
      settings: {},
      cache: {
        syncCalendar: jest.fn()
      },
      providerRegistry: {
        refreshBacklogViews: jest.fn()
      }
    };

    const config: TasksProviderConfig = {
      id: 'tasks_1',
      name: 'Test Tasks'
    };

    provider = new TasksPluginProvider(
      config,
      mockPlugin as unknown as FullCalendarPlugin,
      mockApp as unknown as ObsidianInterface
    );
  });

  describe('basic properties', () => {
    it('should have correct static properties', () => {
      expect(TasksPluginProvider.type).toBe('tasks');
      expect(TasksPluginProvider.displayName).toBe('Obsidian Tasks');
      expect(provider.type).toBe('tasks');
      expect(provider.displayName).toBe('Obsidian Tasks');
      expect(provider.isRemote).toBe(false);
      expect(provider.loadPriority).toBe(130);
    });

    it('should return writable capabilities', () => {
      const capabilities = provider.getCapabilities();

      expect(capabilities.canCreate).toBe(false);
      expect(capabilities.canEdit).toBe(true);
      expect(capabilities.canDelete).toBe(true);
    });
  });

  describe('Tasks API integration', () => {
    it('should reject creating events directly', async () => {
      const event = { title: 'Test Event', type: 'single', date: '2024-01-01' } as OFCEvent;

      await expect(provider.createEvent(event)).rejects.toThrow(
        'Full Calendar cannot create tasks directly. Please use the Tasks plugin modal or commands.'
      );
    });

    it('should reject recurring events for update', async () => {
      const handle = { persistentId: 'test::1' };
      const oldEvent = { title: 'Old', type: 'single' } as OFCEvent;
      const newEvent = { title: 'New', type: 'recurring' } as OFCEvent;

      await expect(provider.updateEvent(handle, oldEvent, newEvent)).rejects.toThrow(
        'Tasks provider can only update single, dated events.'
      );
    });

    it('should reject invalid handle format for delete', async () => {
      const handle = { persistentId: 'invalid-format' };

      await expect(provider.deleteEvent(handle)).rejects.toThrow(
        'Invalid task handle format. Expected "filePath::lineNumber".'
      );
    });

    it('should still reject instance overrides', async () => {
      const masterEvent = { title: 'Master' } as OFCEvent;
      const instanceDate = '2024-01-15';
      const newEventData = { title: 'Override' } as OFCEvent;

      await expect(
        provider.createInstanceOverride(masterEvent, instanceDate, newEventData)
      ).rejects.toThrow('Tasks provider does not support recurring event overrides.');
    });
  });

  describe('manual Tasks cache sync', () => {
    it('forces a fresh Tasks cache request and syncs dated tasks into EventCache', async () => {
      const today = new Date('2026-04-28T12:00:00');
      const tasks = [
        createTask({
          description: 'Due today (09:00)',
          dueDate: taskDate('2026-04-28'),
          originalMarkdown: '- [ ] Due today (09:00) 📅 2026-04-28'
        }),
        createTask({
          path: 'project.md',
          description: 'Starts today',
          taskLocation: { lineNumber: 3 },
          startDate: taskDate('2026-04-28'),
          originalMarkdown: '- [ ] Starts today 🛫 2026-04-28'
        }),
        createTask({
          path: 'later.md',
          description: 'Due tomorrow',
          dueDate: taskDate('2026-04-29'),
          originalMarkdown: '- [ ] Due tomorrow 📅 2026-04-29'
        })
      ];

      mockPlugin.app.workspace.trigger.mockImplementation(
        (eventName: string, callback: (data: unknown) => void) => {
          if (eventName === 'obsidian-tasks-plugin:request-cache-update') {
            callback({ state: { name: 'Warm' }, tasks });
          }
        }
      );

      const result = await provider.syncTasksFromPlugin(today);

      expect(mockPlugin.app.workspace.trigger).toHaveBeenCalledWith(
        'obsidian-tasks-plugin:request-cache-update',
        expect.any(Function)
      );
      expect(mockPlugin.cache.syncCalendar).toHaveBeenCalledWith('tasks_1', expect.any(Array));

      const syncedEvents = mockPlugin.cache.syncCalendar.mock.calls[0][1];
      expect(syncedEvents).toHaveLength(3);
      expect(syncedEvents[0][0]).toMatchObject({
        title: 'Due today',
        date: '2026-04-28',
        allDay: false,
        startTime: '09:00'
      });
      expect(syncedEvents[1][0]).toMatchObject({
        title: 'Starts today',
        date: '2026-04-28',
        allDay: true
      });
      expect(result).toEqual({ todayCount: 2, eventCount: 3 });
      expect(mockPlugin.providerRegistry.refreshBacklogViews).toHaveBeenCalled();
    });
  });

  describe('event handle generation', () => {
    it('should generate event handle from UID', () => {
      const event = {
        uid: 'test-file.md::5',
        title: 'Test Task'
      } as OFCEvent;

      const handle = provider.getEventHandle(event);

      expect(handle).not.toBeNull();
      expect(handle!.persistentId).toBe('test-file.md::5');
    });

    it('should return null for event without UID', () => {
      const event = {
        title: 'Test Task'
      } as OFCEvent;

      const handle = provider.getEventHandle(event);

      expect(handle).toBeNull();
    });
  });

  describe('constructor validation', () => {
    it('should throw error when ObsidianInterface is not provided', () => {
      const config: TasksProviderConfig = { id: 'tasks_1' };

      expect(() => {
        new TasksPluginProvider(config, mockPlugin as unknown as FullCalendarPlugin);
      }).toThrow('TasksPluginProvider requires an Obsidian app interface.');
    });
  });
});
