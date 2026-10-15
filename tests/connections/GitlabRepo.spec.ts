import { describe, it, expect, vi } from "vitest";
import { createMessageQueue } from "../../src/messageQueue";
import { UserTokenStore } from "../../src/tokens/UserTokenStore";
import { AppserviceMock } from "../utils/AppserviceMock";
import { ApiError, ErrCode, ValidatorApiError } from "../../src/api";
import {
  GitLabRepoConnection,
  GitLabRepoConnectionState,
} from "../../src/Connections";
import { BridgeConfigGitLab } from "../../src/config/sections/Gitlab";
import { IBridgeStorageProvider } from "../../src/stores/StorageProvider";
import { IntentMock } from "../utils/IntentMock";
import {
  IGitlabMergeRequest,
  IGitlabProject,
  IGitlabUser,
  IGitLabWebhookNoteEvent,
  IGitLabWebhookMREvent,
  IGitLabWebhookTagPushEvent,
  IGitLabWebhookPushEvent,
  IGitLabWebhookWikiPageEvent,
  IGitLabWebhookReleaseEvent,
  IGitLabWebhookPipelineEvent,
  IGitLabPipelineBuild,
} from "../../src/gitlab/WebhookTypes";
import { DefaultConfig } from "../../src/config/Defaults";

const ROOM_ID = "!foo:bar";

const GITLAB_ORG_REPO = {
  org: "a-fake-org",
  repo: "a-fake-repo",
};

const GITLAB_MR: IGitlabMergeRequest = {
  author_id: 0,
  labels: [],
  state: "opened",
  iid: 1234,
  url: `https://gitlab.example.com/${GITLAB_ORG_REPO.org}/${GITLAB_ORG_REPO.repo}/issues/1234`,
  title: "My MR",
};

const GITLAB_USER: IGitlabUser = {
  name: "Alice",
  username: "alice",
  avatar_url: "",
  email: "alice@example.org",
};

const GITLAB_PROJECT: IGitlabProject = {
  path_with_namespace: `${GITLAB_ORG_REPO.org}/${GITLAB_ORG_REPO.repo}`,
  web_url: `https://gitlab.example.com/${GITLAB_ORG_REPO.org}/${GITLAB_ORG_REPO.repo}`,
  homepage: "",
};

const GITLAB_ISSUE_CREATED_PAYLOAD = {
  object_kind: "merge_request",
  user: GITLAB_USER,
  object_attributes: GITLAB_MR,
  project: GITLAB_PROJECT,
};

const GITLAB_MR_EVENT: IGitLabWebhookMREvent = {
  object_kind: "merge_request",
  event_type: "merge_request",
  user: GITLAB_USER,
  project: GITLAB_PROJECT,
  repository: {
    name: GITLAB_ORG_REPO.repo,
    description: "",
    homepage: GITLAB_PROJECT.web_url,
    url: GITLAB_PROJECT.web_url,
  },
  object_attributes: {
    ...GITLAB_MR,
    action: "open",
  },
  labels: [],
  changes: {},
};

const GITLAB_MR_COMMENT: IGitLabWebhookNoteEvent = {
  object_kind: "note",
  event_type: "note",
  merge_request: GITLAB_MR,
  object_attributes: {
    discussion_id: "6babfc4ad3be2355db286ed50be111a5220d5751",
    note: "I am starting a new thread",
    noteable_type: "MergeRequest",
    url: "https://gitlab.com/tadeuszs/my-awesome-project/-/merge_requests/2#note_1455087141",
    id: 1455087141,
    author_id: 12345,
    noteable_id: 1,
  },
  project: GITLAB_PROJECT,
  user: GITLAB_USER,
  repository: {
    description: "A repo",
    homepage: "https://gitlab.com/tadeuszs/my-awesome-project",
    name: "a-repo",
    url: "https://gitlab.com/tadeuszs/my-awesome-project",
  },
};

const GITLAB_PIPELINE_EVENT: IGitLabWebhookPipelineEvent = {
  object_kind: "pipeline",
  user: {
    name: "Test User",
    username: "testuser",
    avatar_url: "",
  },
  project: {
    name: "Test Project",
    web_url: "https://gitlab.example.com/test/project",
    path_with_namespace: "test/project",
  },
  object_attributes: {
    id: 1,
    status: "success",
    ref: "main",
    tag: false,
    url: "https://gitlab.example.com/test/project/-/pipelines/1",
    duration: 120,
    created_at: "2025-05-20T10:00:00Z",
    finished_at: "2025-05-20T10:02:00Z",
  },
};

const COMMENT_DEBOUNCE_MS = 25;

function createConnection(
  state: Partial<GitLabRepoConnectionState> = {},
  isExistingState = false,
  config: Partial<BridgeConfigGitLab> = {},
): {
  connection: GitLabRepoConnection;
  intent: IntentMock;
  storage: {
    setGitlabPipelineThreads: ReturnType<typeof vi.fn>;
  };
} {
  const mq = createMessageQueue();
  mq.subscribe("*");
  const as = AppserviceMock.create();
  const intent = as.getIntentForUserId("@gitlab:example.test");
  const storage = {
    setGitlabDiscussionThreads: () => Promise.resolve(),
    getGitlabDiscussionThreads: () => Promise.resolve([]),
    setGitlabPipelineThreads: vi.fn(() => Promise.resolve()),
    getGitlabPipelineThreads: () => Promise.resolve([]),
  };
  const connection = new GitLabRepoConnection(
    ROOM_ID,
    "state_key",
    as,
    {
      commentDebounceMs: COMMENT_DEBOUNCE_MS,
      ...config,
    } as BridgeConfigGitLab,
    intent,
    GitLabRepoConnection.validateState(
      {
        instance: "bar",
        path: "foo",
        ...state,
      },
      isExistingState,
    ),
    {} as UserTokenStore,
    {
      url: "https://gitlab.example.com",
    },
    storage as unknown as IBridgeStorageProvider,
    DefaultConfig.messaging,
  );
  return { connection, intent, storage };
}

async function waitForDebouncing(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, COMMENT_DEBOUNCE_MS * 2));
}

describe("GitLabRepoConnection", () => {
  describe("validateState", () => {
    it("can validate a completes state config", () => {
      GitLabRepoConnection.validateState({
        instance: "foo",
        path: "bar/baz",
        enableHooks: [
          "merge_request.open",
          "merge_request.reopen",
          "merge_request.close",
          "merge_request.merge",
          "merge_request.review",
          "merge_request.review.comments",
          "merge_request",
          "tag_push",
          "push",
          "wiki",
          "release",
          "release.created",
        ],
        commandPrefix: "!gl",
        pushTagsRegex: ".*",
        includingLabels: ["me"],
        excludingLabels: ["but-not-me"],
      } as GitLabRepoConnectionState as unknown as Record<string, unknown>);
    });

    it("will convert ignoredHooks for existing state", () => {
      const state = GitLabRepoConnection.validateState(
        {
          instance: "foo",
          path: "bar/baz",
          ignoreHooks: ["merge_request"],
          commandPrefix: "!gl",
        } as GitLabRepoConnectionState as unknown as Record<string, unknown>,
        true,
      );
      expect(state.enableHooks).not.toContain("merge_request");
    });

    it("will disallow invalid state", () => {
      try {
        GitLabRepoConnection.validateState({
          instance: "foo",
          path: 123,
        });
      } catch (ex) {
        if (
          ex instanceof ValidatorApiError === false ||
          ex.errcode !== ErrCode.BadValue
        ) {
          throw ex;
        }
      }
    });

    it("will disallow enabledHooks to contains invalid enums if this is new state", () => {
      try {
        GitLabRepoConnection.validateState(
          {
            instance: "bar",
            path: "foo",
            enabledHooks: ["not-real"],
          },
          false,
        );
      } catch (ex) {
        if (
          ex instanceof ApiError === false ||
          ex.errcode !== ErrCode.BadValue
        ) {
          throw ex;
        }
      }
    });

    it("will allow enabledHooks to contains invalid enums if this is old state", () => {
      GitLabRepoConnection.validateState(
        {
          instance: "bar",
          path: "foo",
          enabledHooks: ["not-real"],
        },
        true,
      );
    });
  });

  describe("onMergeRequestCommentCreated", () => {
    it("will handle an MR comment", async () => {
      const { connection, intent } = createConnection();
      await connection.onMergeRequestCommentCreated(GITLAB_MR_COMMENT);
      await waitForDebouncing();
      intent.expectEventMatches(
        (ev: any) => ev.content.body.includes("**Alice** commented on MR"),
        "event body indicates MR comment",
      );
      intent.expectEventBodyContains(
        GITLAB_MR_COMMENT.project.path_with_namespace,
        0,
      );
    });

    it("will filter out issues not matching includingLabels.", async () => {
      const { connection, intent } = createConnection({
        includingLabels: ["include-me"],
      });
      // ..or issues with no labels
      await connection.onMergeRequestCommentCreated(GITLAB_MR_COMMENT);
      await waitForDebouncing();
      intent.expectNoEvent();
    });

    it("will filter out issues matching excludingLabels.", async () => {
      const { connection, intent } = createConnection({
        excludingLabels: ["exclude-me"],
      });
      // ..or issues with no labels
      await connection.onMergeRequestCommentCreated({
        ...GITLAB_MR_COMMENT,
        merge_request: {
          ...GITLAB_MR,
          labels: [
            {
              id: 0,
              title: "exclude-me",
            } as any,
          ],
        },
      });
      await waitForDebouncing();
      intent.expectNoEvent();
    });

    it("will debounce MR comments", async () => {
      const { connection, intent } = createConnection();
      await connection.onMergeRequestCommentCreated(GITLAB_MR_COMMENT);
      await connection.onMergeRequestCommentCreated({
        ...GITLAB_MR_COMMENT,
        object_attributes: {
          ...GITLAB_MR_COMMENT.object_attributes,
          discussion_id: "fa5d",
          note: "different comment",
        },
      } as never);
      await waitForDebouncing();
      expect(intent.sentEvents.length).toBe(1);
      intent.expectEventMatches(
        (ev: any) => ev.content.body.includes("with 2 comments"),
        "one event sent for both comments",
        0,
      );
    });

    it("will add new comments in a Matrix thread", async () => {
      const { connection, intent } = createConnection();
      await connection.onMergeRequestCommentCreated(GITLAB_MR_COMMENT);
      await waitForDebouncing();
      await connection.onMergeRequestCommentCreated(GITLAB_MR_COMMENT);
      await waitForDebouncing();
      expect(intent.sentEvents.length).toBe(2);
      intent.expectEventMatches(
        (ev: any) => ev.content["m.relates_to"].event_id === "event_0",
        "one event sent for both comments",
        1,
      );
    });

    it("will correctly map new comments to aggregated discussions", async () => {
      const { connection, intent } = createConnection();
      await connection.onMergeRequestCommentCreated({
        ...GITLAB_MR_COMMENT,
        object_attributes: {
          ...GITLAB_MR_COMMENT.object_attributes,
          discussion_id: "disc1",
        },
      } as never);
      await connection.onMergeRequestCommentCreated({
        ...GITLAB_MR_COMMENT,
        object_attributes: {
          ...GITLAB_MR_COMMENT.object_attributes,
          discussion_id: "disc2",
        },
      } as never);
      await waitForDebouncing();
      expect(intent.sentEvents.length).toBe(1);

      await connection.onMergeRequestCommentCreated({
        ...GITLAB_MR_COMMENT,
        object_attributes: {
          ...GITLAB_MR_COMMENT.object_attributes,
          discussion_id: "disc1",
        },
      } as never);
      await waitForDebouncing();
      expect(intent.sentEvents.length).toBe(2);
      intent.expectEventMatches(
        (ev: any) => ev.content["m.relates_to"].event_id === "event_0",
        "disc1 reply goes to existing thread",
        1,
      );

      await connection.onMergeRequestCommentCreated({
        ...GITLAB_MR_COMMENT,
        object_attributes: {
          ...GITLAB_MR_COMMENT.object_attributes,
          discussion_id: "disc2",
        },
      } as never);
      await waitForDebouncing();
      expect(intent.sentEvents.length).toBe(3);
      intent.expectEventMatches(
        (ev: any) => ev.content["m.relates_to"].event_id === "event_0",
        "disc2 reply also goes to existing thread",
        2,
      );
    });
  });

  describe("onIssueCreated", () => {
    it("will handle a simple issue", async () => {
      const { connection, intent } = createConnection();
      await connection.onMergeRequestOpened(
        GITLAB_ISSUE_CREATED_PAYLOAD as never,
      );
      // Statement text.
      intent.expectEventBodyContains("**alice** opened a new MR", 0);
      intent.expectEventBodyContains(
        GITLAB_ISSUE_CREATED_PAYLOAD.object_attributes.url,
        0,
      );
      intent.expectEventBodyContains(
        GITLAB_ISSUE_CREATED_PAYLOAD.object_attributes.title,
        0,
      );
      intent.expectEventBodyContains(
        GITLAB_ISSUE_CREATED_PAYLOAD.project.path_with_namespace,
        0,
      );
    });

    it("will filter out issues not matching includingLabels.", async () => {
      const { connection, intent } = createConnection({
        includingLabels: ["include-me"],
      });
      await connection.onMergeRequestOpened({
        ...GITLAB_ISSUE_CREATED_PAYLOAD,
        labels: [
          {
            title: "foo",
          },
        ],
      } as never);
      // ..or issues with no labels
      await connection.onMergeRequestOpened(
        GITLAB_ISSUE_CREATED_PAYLOAD as never,
      );
      intent.expectNoEvent();
    });

    it("will filter out issues matching excludingLabels.", async () => {
      const { connection, intent } = createConnection({
        excludingLabels: ["exclude-me"],
      });
      await connection.onMergeRequestOpened({
        ...GITLAB_ISSUE_CREATED_PAYLOAD,
        labels: [
          {
            title: "exclude-me",
          },
        ],
      } as never);
      intent.expectNoEvent();
    });

    it("will include issues matching includingLabels.", async () => {
      const { connection, intent } = createConnection({
        includingLabels: ["include-me"],
      });
      await connection.onMergeRequestOpened({
        ...GITLAB_ISSUE_CREATED_PAYLOAD,
        labels: [
          {
            title: "include-me",
          },
        ],
      } as never);
      intent.expectEventBodyContains("**alice** opened a new MR", 0);
      intent.expectEventBodyContains(
        GITLAB_ISSUE_CREATED_PAYLOAD.project.path_with_namespace,
        0,
      );
    });
  });

  describe("onMergeRequestReopened", () => {
    it("will handle a reopened MR", async () => {
      const { connection, intent } = createConnection();
      await connection.onMergeRequestReopened({
        ...GITLAB_MR_EVENT,
        object_attributes: {
          ...GITLAB_MR_EVENT.object_attributes,
          action: "reopen",
        },
      });
      intent.expectEventBodyContains("**alice** reopened MR", 0);
      intent.expectEventBodyContains(GITLAB_MR.title, 0);
      intent.expectEventBodyContains(GITLAB_MR.url, 0);
      intent.expectEventBodyContains(
        GITLAB_MR_EVENT.project.path_with_namespace,
        0,
      );
    });

    it("will filter out MRs matching excludingLabels", async () => {
      const { connection, intent } = createConnection({
        excludingLabels: ["blocked"],
      });
      await connection.onMergeRequestReopened({
        ...GITLAB_MR_EVENT,
        object_attributes: {
          ...GITLAB_MR_EVENT.object_attributes,
          action: "reopen",
        },
        labels: [{ title: "blocked" } as never],
      });
      intent.expectNoEvent();
    });
  });

  describe("onMergeRequestClosed", () => {
    it("will handle a closed MR", async () => {
      const { connection, intent } = createConnection();
      await connection.onMergeRequestClosed({
        ...GITLAB_MR_EVENT,
        object_attributes: {
          ...GITLAB_MR_EVENT.object_attributes,
          action: "close",
        },
      });
      intent.expectEventBodyContains("**alice** closed MR", 0);
      intent.expectEventBodyContains(GITLAB_MR.title, 0);
      intent.expectEventBodyContains(
        GITLAB_MR_EVENT.project.path_with_namespace,
        0,
      );
    });
  });

  describe("onMergeRequestMerged", () => {
    it("will handle a merged MR", async () => {
      const { connection, intent } = createConnection();
      await connection.onMergeRequestMerged({
        ...GITLAB_MR_EVENT,
        object_attributes: {
          ...GITLAB_MR_EVENT.object_attributes,
          action: "merge",
        },
      });
      intent.expectEventBodyContains("**alice** merged MR", 0);
      intent.expectEventBodyContains(GITLAB_MR.title, 0);
      intent.expectEventBodyContains(
        GITLAB_MR_EVENT.project.path_with_namespace,
        0,
      );
    });
  });

  describe("onMergeRequestUpdate", () => {
    it("will handle an MR marked as ready for review", async () => {
      const { connection, intent } = createConnection();
      await connection.onMergeRequestUpdate({
        ...GITLAB_MR_EVENT,
        changes: { draft: { previous: true, current: false } },
      });
      intent.expectEventBodyContains("**alice**", 0);
      intent.expectEventBodyContains("ready for review", 0);
      intent.expectEventBodyContains(GITLAB_MR.title, 0);
      intent.expectEventBodyContains(
        GITLAB_MR_EVENT.project.path_with_namespace,
        0,
      );
    });

    it("will handle an MR converted back to draft", async () => {
      const { connection, intent } = createConnection();
      await connection.onMergeRequestUpdate({
        ...GITLAB_MR_EVENT,
        changes: { draft: { previous: false, current: true } },
      });
      intent.expectEventBodyContains("**alice**", 0);
      intent.expectEventBodyContains("as draft", 0);
      intent.expectEventBodyContains(
        GITLAB_MR_EVENT.project.path_with_namespace,
        0,
      );
    });

    it("will skip updates with no draft change", async () => {
      const { connection, intent } = createConnection();
      await connection.onMergeRequestUpdate({
        ...GITLAB_MR_EVENT,
        changes: {},
      });
      intent.expectNoEvent();
    });
  });

  describe("onGitLabTagPush", () => {
    const GITLAB_TAG_PUSH_EVENT: IGitLabWebhookTagPushEvent = {
      object_kind: "tag_push",
      user_id: 1,
      user_name: "Alice",
      ref: "refs/tags/v1.0.0",
      before: "0000000000000000000000000000000000000000",
      after: "abc1234abc1234abc1234abc1234abc1234abc123",
      project: GITLAB_PROJECT,
      repository: {
        name: GITLAB_ORG_REPO.repo,
        description: "",
        homepage: GITLAB_PROJECT.web_url,
        url: GITLAB_PROJECT.web_url,
      },
    };

    it("will handle a tag push", async () => {
      const { connection, intent } = createConnection();
      await connection.onGitLabTagPush(GITLAB_TAG_PUSH_EVENT);
      intent.expectEventBodyContains("**Alice**", 0);
      intent.expectEventBodyContains("pushed tag", 0);
      intent.expectEventBodyContains("v1.0.0", 0);
      intent.expectEventBodyContains(
        GITLAB_TAG_PUSH_EVENT.project.path_with_namespace,
        0,
      );
    });

    it("will filter tags not matching pushTagsRegex", async () => {
      const { connection, intent } = createConnection({
        pushTagsRegex: "^release-",
      });
      await connection.onGitLabTagPush(GITLAB_TAG_PUSH_EVENT);
      intent.expectNoEvent();
    });
  });

  describe("onGitLabPush", () => {
    const GITLAB_PUSH_EVENT: IGitLabWebhookPushEvent = {
      object_kind: "push",
      before: "0000000000000000000000000000000000000000",
      after: "abc1234abc1234abc1234abc1234abc1234abc123",
      ref: "refs/heads/main",
      user_id: 1,
      user_name: "Alice",
      user_email: "alice@example.org",
      project: GITLAB_PROJECT,
      repository: {
        name: GITLAB_ORG_REPO.repo,
        description: "",
        homepage: GITLAB_PROJECT.web_url,
        url: GITLAB_PROJECT.web_url,
      },
      commits: [
        {
          id: "abc1234abc1234abc1234abc1234abc1234abc123",
          message: "Fix bug\n",
          title: "Fix bug",
          timestamp: "2024-01-01T00:00:00Z",
          url: `${GITLAB_PROJECT.web_url}/-/commit/abc1234`,
          author: { name: "Alice", email: "alice@example.org" },
          added: [],
          modified: ["README.md"],
          removed: [],
        },
        {
          id: "def5678def5678def5678def5678def5678def56",
          message: "Add feature\n",
          title: "Add feature",
          timestamp: "2024-01-01T01:00:00Z",
          url: `${GITLAB_PROJECT.web_url}/-/commit/def5678`,
          author: { name: "Alice", email: "alice@example.org" },
          added: ["src/feature.ts"],
          modified: [],
          removed: [],
        },
      ],
      total_commits_count: 2,
    } as IGitLabWebhookPushEvent;

    it("will handle a push with multiple commits", async () => {
      const { connection, intent } = createConnection();
      await connection.onGitLabPush(GITLAB_PUSH_EVENT);
      intent.expectEventBodyContains("**Alice**", 0);
      intent.expectEventBodyContains("2 commits", 0);
      intent.expectEventBodyContains("main", 0);
      intent.expectEventBodyContains(
        GITLAB_PUSH_EVENT.project.path_with_namespace,
        0,
      );
    });

    it("will handle a push with a single commit", async () => {
      const { connection, intent } = createConnection();
      await connection.onGitLabPush({
        ...GITLAB_PUSH_EVENT,
        commits: [
          {
            id: "aaa0000aaa0000aaa0000aaa0000aaa0000aaa00",
            message: "Single change\n",
            title: "Single change",
            timestamp: "2024-01-01T00:00:00Z",
            url: `${GITLAB_PROJECT.web_url}/-/commit/aaa0000`,
            author: { name: "Alice", email: "alice@example.org" },
            added: [],
            modified: ["README.md"],
            removed: [],
          },
        ],
        total_commits_count: 1,
      });
      intent.expectEventBodyContains("1 commit", 0);
      intent.expectEventBodyContains("Single change", 0);
      intent.expectEventBodyContains(
        GITLAB_PUSH_EVENT.project.path_with_namespace,
        0,
      );
    });
  });

  describe("onWikiPageEvent", () => {
    const baseWikiEvent: IGitLabWebhookWikiPageEvent = {
      object_kind: "wiki_page",
      user: GITLAB_USER,
      project: GITLAB_PROJECT,
      wiki: {
        web_url: `${GITLAB_PROJECT.web_url}/-/wikis`,
        path_with_namespace: `${GITLAB_ORG_REPO.org}/${GITLAB_ORG_REPO.repo}.wiki`,
      },
      object_attributes: {
        title: "Home",
        url: `${GITLAB_PROJECT.web_url}/-/wikis/home`,
        message: "Initial commit",
        format: "markdown",
        content: "# Home",
        action: "create",
      },
    };

    it("will handle a wiki page creation", async () => {
      const { connection, intent } = createConnection();
      await connection.onWikiPageEvent(baseWikiEvent);
      intent.expectEventBodyContains("**alice**", 0);
      intent.expectEventBodyContains("created new wiki page", 0);
      intent.expectEventBodyContains("Home", 0);
      intent.expectEventBodyContains(
        GITLAB_MR_EVENT.project.path_with_namespace,
        0,
      );
    });

    it("will handle a wiki page update", async () => {
      const { connection, intent } = createConnection();
      await connection.onWikiPageEvent({
        ...baseWikiEvent,
        object_attributes: {
          ...baseWikiEvent.object_attributes,
          action: "update",
        },
      });
      intent.expectEventBodyContains("updated wiki page", 0);
      intent.expectEventBodyContains(
        GITLAB_MR_EVENT.project.path_with_namespace,
        0,
      );
    });

    it("will handle a wiki page deletion", async () => {
      const { connection, intent } = createConnection();
      await connection.onWikiPageEvent({
        ...baseWikiEvent,
        object_attributes: {
          ...baseWikiEvent.object_attributes,
          action: "delete",
        },
      });
      intent.expectEventBodyContains("deleted wiki page", 0);
      intent.expectEventBodyContains(
        GITLAB_MR_EVENT.project.path_with_namespace,
        0,
      );
    });
  });

  describe("onRelease", () => {
    const GITLAB_RELEASE_EVENT: IGitLabWebhookReleaseEvent = {
      object_kind: "release",
      description: "First stable release.",
      name: "v1.0.0",
      tag: "v1.0.0",
      created_at: "2024-01-01T00:00:00Z",
      released_at: "2024-01-01T00:00:00Z",
      url: `${GITLAB_PROJECT.web_url}/-/releases/v1.0.0`,
      action: "create",
      project: GITLAB_PROJECT,
      commit: {
        id: "abc1234",
        message: "Release v1.0.0",
        title: "Release v1.0.0",
        timestamp: "2024-01-01T00:00:00Z",
        url: `${GITLAB_PROJECT.web_url}/-/commit/abc1234`,
        author: { name: "Alice", email: "alice@example.org" },
      },
    } as IGitLabWebhookReleaseEvent;

    it("will handle a release", async () => {
      const { connection, intent } = createConnection();
      await connection.onRelease(GITLAB_RELEASE_EVENT);
      intent.expectEventBodyContains("**Alice**", 0);
      intent.expectEventBodyContains("released", 0);
      intent.expectEventBodyContains("v1.0.0", 0);
      intent.expectEventBodyContains("First stable release.", 0);
      intent.expectEventBodyContains(
        GITLAB_RELEASE_EVENT.project.path_with_namespace,
        0,
      );
    });
  });

  describe("onMergeRequestReviewed", () => {
    it("will handle an approved review", async () => {
      const { connection, intent } = createConnection();
      await connection.onMergeRequestReviewed({
        ...GITLAB_MR_EVENT,
        object_attributes: {
          ...GITLAB_MR_EVENT.object_attributes,
          action: "approved",
        },
      });
      await waitForDebouncing();
      intent.expectEventBodyContains("**Alice**", 0);
      intent.expectEventBodyContains("✅ approved", 0);
      intent.expectEventBodyContains(GITLAB_MR.title, 0);
      intent.expectEventBodyContains(
        GITLAB_MR_EVENT.project.path_with_namespace,
        0,
      );
    });

    it("will handle an unapproved review", async () => {
      const { connection, intent } = createConnection();
      await connection.onMergeRequestReviewed({
        ...GITLAB_MR_EVENT,
        object_attributes: {
          ...GITLAB_MR_EVENT.object_attributes,
          action: "unapproved",
        },
      });
      await waitForDebouncing();
      intent.expectEventBodyContains("🔴 requested changes", 0);
      intent.expectEventBodyContains(
        GITLAB_MR_EVENT.project.path_with_namespace,
        0,
      );
    });
  });

  describe("onMergeRequestIndividualReview", () => {
    it("will handle an individual review approval", async () => {
      const { connection, intent } = createConnection();
      await connection.onMergeRequestIndividualReview({
        ...GITLAB_MR_EVENT,
        object_attributes: {
          ...GITLAB_MR_EVENT.object_attributes,
          action: "approved",
        },
      });
      await waitForDebouncing();
      intent.expectEventBodyContains("**Alice**", 0);
      intent.expectEventBodyContains("✅ approved", 0);
      intent.expectEventBodyContains(GITLAB_MR.title, 0);
      intent.expectEventBodyContains(
        GITLAB_MR_EVENT.project.path_with_namespace,
        0,
      );
    });
  });

  describe("onPipelineEvent", () => {
    function pipelineEvent(
      attributes: Partial<IGitLabWebhookPipelineEvent["object_attributes"]>,
      project: Partial<IGitLabWebhookPipelineEvent["project"]> = {},
    ): IGitLabWebhookPipelineEvent {
      return {
        ...GITLAB_PIPELINE_EVENT,
        project: { ...GITLAB_PIPELINE_EVENT.project, ...project },
        object_attributes: {
          ...GITLAB_PIPELINE_EVENT.object_attributes,
          ...attributes,
        },
      };
    }

    const statuses = [
      { status: "running", label: "RUNNING", color: "#1f75cb" },
      { status: "success", label: "SUCCESS", color: "#00aa00" },
      { status: "failed", label: "FAILED", color: "#ff0000" },
      { status: "canceled", label: "CANCELED", color: "#a9a9a9" },
      { status: "manual", label: "MANUAL", color: "#ff8800" },
    ] as const;

    it.each(statuses)(
      "should skip $status if hook is disabled",
      async ({ status }) => {
        const { connection, intent } = createConnection({ enableHooks: [] });
        await connection.onPipelineEvent(pipelineEvent({ status }));
        intent.expectNoEvent();
      },
    );

    it.each(statuses)(
      "should send $status when its subtype is enabled",
      async ({ status, label, color }) => {
        const { connection, intent } = createConnection({
          enableHooks: [`pipeline.${status}`],
        });
        await connection.onPipelineEvent(pipelineEvent({ status }));
        expect(intent.sentEvents[0].content.body).toContain(`**${label}**`);
        expect(intent.sentEvents[0].content.formatted_body).toContain(
          `<span data-mx-color="${color}"><b>${label}</b></span>`,
        );
      },
    );

    it("should skip a status whose subtype is not enabled", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline.failed"],
      });
      await connection.onPipelineEvent(pipelineEvent({ status: "success" }));
      intent.expectNoEvent();
    });

    it("should ignore statuses it does not notify about", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline"],
      });
      await connection.onPipelineEvent(pipelineEvent({ status: "pending" }));
      intent.expectNoEvent();
    });

    it("should link to the pipeline", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline"],
      });
      await connection.onPipelineEvent(
        pipelineEvent({
          id: 42,
          url: "https://gitlab.example.com/test/project/-/pipelines/42",
        }),
      );
      expect(intent.sentEvents[0].content.body).toContain(
        "[#42](https://gitlab.example.com/test/project/-/pipelines/42)",
      );
      expect(intent.sentEvents[0].content.formatted_body).toContain(
        '<a href="https://gitlab.example.com/test/project/-/pipelines/42">#42</a>',
      );
    });

    it("should build the pipeline link when the payload has no url", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline"],
      });
      await connection.onPipelineEvent(
        pipelineEvent({ id: 42, url: undefined }),
      );
      expect(intent.sentEvents[0].content.formatted_body).toContain(
        '<a href="https://gitlab.example.com/test/project/-/pipelines/42">#42</a>',
      );
    });

    it("should show the duration when present", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline"],
      });
      await connection.onPipelineEvent(pipelineEvent({ duration: 120 }));
      expect(intent.sentEvents[0].content.body).toMatch(
        /\*\* - Duration: 120s$/,
      );
      expect(intent.sentEvents[0].content.formatted_body).toMatch(
        /<\/b> - Duration: 120s$/,
      );
    });

    it("should omit the duration when absent", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline"],
      });
      await connection.onPipelineEvent(
        pipelineEvent({ status: "running", duration: null }),
      );
      expect(intent.sentEvents[0].content.body).not.toContain("Duration");
      expect(intent.sentEvents[0].content.formatted_body).not.toContain(
        "Duration",
      );
      expect(intent.sentEvents[0].content.formatted_body).toMatch(/<\/b>$/);
    });

    it("should say tag for tag pipelines", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline"],
      });
      await connection.onPipelineEvent(
        pipelineEvent({ ref: "v1.0.0", tag: true }),
      );
      intent.expectEventBodyContains("on tag `v1.0.0`", 0);
    });

    it("should say branch for branch pipelines", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline"],
      });
      await connection.onPipelineEvent(pipelineEvent({ ref: "main" }));
      intent.expectEventBodyContains("on branch `main`", 0);
    });

    it("should mention the manual job when waiting for one", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline"],
      });
      await connection.onPipelineEvent(
        pipelineEvent({ status: "manual", duration: null }),
      );
      intent.expectEventBodyContains("waiting for a manual job", 0);
    });

    function job(
      id: number,
      name: string,
      status: IGitLabPipelineBuild["status"],
      extra: Partial<IGitLabPipelineBuild> = {},
    ): IGitLabPipelineBuild {
      return {
        id,
        stage: "test",
        name,
        status,
        allow_failure: false,
        failure_reason: null,
        ...extra,
      };
    }

    it("should list the failed jobs with links and reasons", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline"],
      });
      await connection.onPipelineEvent({
        ...pipelineEvent({ status: "failed", duration: 31 }),
        builds: [
          job(12, "lint", "failed", {
            allow_failure: true,
            failure_reason: "script_failure",
          }),
          job(11, "test", "failed", { failure_reason: "script_failure" }),
          job(10, "build", "success"),
        ],
      });
      const { body, formatted_body } = intent.sentEvents[0].content;
      expect(body).toMatch(
        /\*\* - failed job: \[test\]\(https:\/\/gitlab\.example\.com\/test\/project\/-\/jobs\/11\) \(script failure\) - Duration: 31s$/,
      );
      expect(body).not.toContain("lint");
      expect(formatted_body).toContain(
        ' - failed job: <a href="https://gitlab.example.com/test/project/-/jobs/11">test</a> (script failure) - Duration: 31s',
      );
    });

    it("should name the manual jobs a pipeline waits for", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline"],
      });
      await connection.onPipelineEvent({
        ...pipelineEvent({ status: "manual", duration: null }),
        builds: [
          job(21, "deploy-eu", "manual"),
          job(20, "deploy-us", "manual"),
          job(22, "release-notes", "manual", { allow_failure: true }),
          job(19, "test", "success"),
        ],
      });
      const { body } = intent.sentEvents[0].content;
      expect(body).toContain(
        " - waiting for manual jobs: [deploy-us](https://gitlab.example.com/test/project/-/jobs/20), [deploy-eu](https://gitlab.example.com/test/project/-/jobs/21)",
      );
      expect(body).not.toContain("waiting for a manual job");
      expect(body).not.toContain("release-notes");
    });

    it("should report a manual job left waiting after success", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline"],
      });
      await connection.onPipelineEvent({
        ...pipelineEvent({ status: "success" }),
        builds: [
          job(31, "release", "manual", { allow_failure: true }),
          job(30, "test", "success"),
        ],
      });
      expect(intent.sentEvents[0].content.body).toContain(
        " - manual job not run: [release](https://gitlab.example.com/test/project/-/jobs/31)",
      );
    });

    it("should add nothing for a plain success or a running pipeline", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline"],
      });
      const builds = [job(41, "test", "success"), job(42, "deploy", "manual")];
      await connection.onPipelineEvent({
        ...pipelineEvent({ status: "success" }),
        builds: [job(40, "test", "success")],
      });
      await connection.onPipelineEvent({
        ...pipelineEvent({ status: "running", duration: null }),
        builds,
      });
      expect(intent.sentEvents[0].content.body).not.toContain("job");
      expect(intent.sentEvents[1].content.body).not.toContain("job");
    });

    it("should cap the number of listed jobs", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline"],
      });
      await connection.onPipelineEvent({
        ...pipelineEvent({ status: "failed" }),
        builds: [1, 2, 3, 4, 5, 6, 7].map((n) => job(n, `job${n}`, "failed")),
      });
      const { body } = intent.sentEvents[0].content;
      expect(body).toContain("[job5]");
      expect(body).not.toContain("[job6]");
      expect(body).toContain(" and 2 more");
    });

    it("should escape job names in HTML", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline"],
      });
      await connection.onPipelineEvent({
        ...pipelineEvent({ status: "failed" }),
        builds: [job(50, "<b>x</b>", "failed")],
      });
      const html = intent.sentEvents[0].content.formatted_body;
      expect(html).toContain(">&lt;b&gt;x&lt;/b&gt;</a>");
    });

    describe("threads", () => {
      const threaded = {
        enableHooks: ["pipeline"],
        pipelineThreads: true,
      } as const;

      function relation(index: number, intent: IntentMock) {
        return intent.sentEvents[index].content["m.relates_to"] as
          | { rel_type: string; event_id: string }
          | undefined;
      }

      it("should not thread unless enabled", async () => {
        const { connection, intent } = createConnection({
          enableHooks: ["pipeline"],
        });
        await connection.onPipelineEvent(pipelineEvent({ status: "running" }));
        await connection.onPipelineEvent(pipelineEvent({ status: "success" }));
        expect(relation(0, intent)).toBeUndefined();
        expect(relation(1, intent)).toBeUndefined();
      });

      it("should post later updates in a thread under the first message", async () => {
        const { connection, intent } = createConnection(threaded);
        await connection.onPipelineEvent(pipelineEvent({ status: "running" }));
        await connection.onPipelineEvent(pipelineEvent({ status: "manual" }));
        await connection.onPipelineEvent(pipelineEvent({ status: "success" }));
        expect(relation(0, intent)).toBeUndefined();
        for (const index of [1, 2]) {
          expect(relation(index, intent)).toEqual({
            rel_type: "m.thread",
            event_id: "event_0",
            is_falling_back: true,
            "m.in_reply_to": { event_id: "event_0" },
          });
        }
      });

      it("should start one thread when updates arrive at the same time", async () => {
        const { connection, intent } = createConnection(threaded);
        await Promise.all([
          connection.onPipelineEvent(pipelineEvent({ status: "running" })),
          connection.onPipelineEvent(pipelineEvent({ status: "failed" })),
        ]);
        expect(relation(0, intent)).toBeUndefined();
        expect(relation(1, intent)?.event_id).toEqual("event_0");
      });

      it("should keep separate threads for separate pipelines", async () => {
        const { connection, intent } = createConnection(threaded);
        await connection.onPipelineEvent(
          pipelineEvent({ id: 1, status: "running" }),
        );
        await connection.onPipelineEvent(
          pipelineEvent({ id: 2, status: "running" }),
        );
        await connection.onPipelineEvent(
          pipelineEvent({ id: 2, status: "success" }),
        );
        await connection.onPipelineEvent(
          pipelineEvent({ id: 1, status: "failed" }),
        );
        expect(relation(1, intent)).toBeUndefined();
        expect(relation(2, intent)?.event_id).toEqual("event_1");
        expect(relation(3, intent)?.event_id).toEqual("event_0");
      });

      it("should start the thread at the first status that is posted", async () => {
        const { connection, intent } = createConnection({
          enableHooks: ["pipeline.failed", "pipeline.success"],
          pipelineThreads: true,
        });
        await connection.onPipelineEvent(pipelineEvent({ status: "running" }));
        await connection.onPipelineEvent(pipelineEvent({ status: "failed" }));
        expect(intent.sentEvents).toHaveLength(1);
        expect(relation(0, intent)).toBeUndefined();
      });

      it("should thread by default when the bridge config says so", async () => {
        const { connection, intent } = createConnection(
          { enableHooks: ["pipeline"] },
          false,
          { defaultOptions: { pipelineThreads: true } },
        );
        await connection.onPipelineEvent(pipelineEvent({ status: "running" }));
        await connection.onPipelineEvent(pipelineEvent({ status: "success" }));
        expect(relation(1, intent)?.event_id).toEqual("event_0");
      });

      it("should let a room turn threads off despite the bridge config", async () => {
        const { connection, intent } = createConnection(
          { enableHooks: ["pipeline"], pipelineThreads: false },
          false,
          { defaultOptions: { pipelineThreads: true } },
        );
        await connection.onPipelineEvent(pipelineEvent({ status: "running" }));
        await connection.onPipelineEvent(pipelineEvent({ status: "success" }));
        expect(relation(1, intent)).toBeUndefined();
      });

      it("should store the thread roots", async () => {
        const { connection, storage } = createConnection(threaded);
        await connection.onPipelineEvent(
          pipelineEvent({ id: 7, status: "running" }),
        );
        await waitForDebouncing();
        expect(storage.setGitlabPipelineThreads).toHaveBeenCalledWith(
          connection.connectionId,
          [{ pipelineId: 7, eventId: "event_0" }],
        );
      });
    });

    it("should escape HTML from the payload", async () => {
      const { connection, intent } = createConnection({
        enableHooks: ["pipeline"],
      });
      await connection.onPipelineEvent(
        pipelineEvent({ ref: "<b>x</b>" }, { name: 'a"<script>' }),
      );
      const html = intent.sentEvents[0].content.formatted_body;
      expect(html).toContain("<code>&lt;b&gt;x&lt;/b&gt;</code>");
      expect(html).toContain("a&quot;&lt;script&gt;</a>");
      expect(html).not.toContain("<script>");
    });
  });
});
