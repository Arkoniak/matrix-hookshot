import { E2ESetupTestTimeout, E2ETestEnv } from "./util/e2e-test";
import { describe, test, beforeAll, afterAll, expect } from "vitest";
import { randomUUID } from "crypto";
import {
  GitLabRepoConnection,
  GitLabRepoConnectionState,
} from "../src/Connections";
import { MessageEventContent } from "matrix-bot-sdk";
import { getBridgeApi } from "./util/bridge-api";
import { waitFor } from "./util/helpers";
import { IGitLabWebhookMREvent } from "../src/gitlab/WebhookTypes";

function mergeRequestEvent(title: string): string {
  return JSON.stringify({
    object_kind: "merge_request",
    event_type: "any",
    user: {
      username: "alice",
      name: "Alice",
      email: "alice@example.org",
      avatar_url: "foobar",
    },
    project: {
      path_with_namespace: "my-project",
      web_url: "https://gitlab.example.org/my-project",
      homepage: "foo",
    },
    repository: {
      name: "example",
      homepage: "foo",
      url: "https://gitlab.example.org",
      description: "https://gitlab.example.org/my-project",
    },
    object_attributes: {
      action: "open",
      title,
      url: "https://gitlab.example.org/my-project/-/merge_requests/1",
      iid: 0,
      author_id: 0,
      state: "opened",
      labels: [],
    },
    labels: [],
    changes: {},
  } satisfies IGitLabWebhookMREvent);
}

describe("GitLab dedicated webhooks", () => {
  let testEnv: E2ETestEnv;
  const webhooksPort = 9500 + E2ETestEnv.workerId;
  const sharedSecret = randomUUID();

  beforeAll(async () => {
    testEnv = await E2ETestEnv.createTestEnv({
      matrixLocalparts: ["user"],
      config: {
        gitlab: {
          webhook: {
            secret: sharedSecret,
            publicUrl: `http://localhost:${webhooksPort}/gitlab/webhook`,
          },
          instances: {
            "example.org": {
              url: "http://gitlab.example.org",
            },
          },
        },
        widgets: {
          publicUrl: `http://localhost:${webhooksPort}`,
        },
        listeners: [
          {
            port: webhooksPort,
            bindAddress: "0.0.0.0",
            resources: ["webhooks", "widgets"],
          },
        ],
      },
    });
    await testEnv.setUp();
  }, E2ESetupTestTimeout);

  afterAll(() => {
    return testEnv?.tearDown();
  });

  test(
    "should route events from a dedicated webhook only to its own room",
    async () => {
      const user = testEnv.getUser("user");
      const bridgeApi = await getBridgeApi(
        testEnv.opts.config?.widgets?.publicUrl!,
        user,
      );

      // Room A: connected through a dedicated webhook, using the command.
      const dedicatedRoomId = await user.createRoom({ name: "Dedicated" });
      const joinA = user.waitForRoomJoin({
        sender: testEnv.botMxid,
        roomId: dedicatedRoomId,
      });
      await user.inviteUser(testEnv.botMxid, dedicatedRoomId);
      await user.setUserPowerLevel(testEnv.botMxid, dedicatedRoomId, 50);
      await joinA;

      // Room B: connected to the same project through the shared webhook.
      const sharedRoomId = await user.createRoom({ name: "Shared" });
      const joinB = user.waitForRoomJoin({
        sender: testEnv.botMxid,
        roomId: sharedRoomId,
      });
      await user.inviteUser(testEnv.botMxid, sharedRoomId);
      await user.setUserPowerLevel(testEnv.botMxid, sharedRoomId, 50);
      await joinB;
      await testEnv.app.appservice.botClient.sendStateEvent(
        sharedRoomId,
        GitLabRepoConnection.CanonicalEventType,
        "shared",
        {
          instance: "example.org",
          path: "my-project",
        } satisfies GitLabRepoConnectionState,
      );
      await waitFor(
        async () =>
          (await bridgeApi.getConnectionsForRoom(sharedRoomId)).length === 1,
      );

      // Create the dedicated connection; the bot sends the details to a new admin room.
      const adminRoomInvite = user.waitForRoomInvite({
        sender: testEnv.botMxid,
      });
      const configured = user.waitForRoomEvent<MessageEventContent>({
        eventType: "m.room.message",
        sender: testEnv.botMxid,
        roomId: dedicatedRoomId,
      });
      await user.sendText(
        dedicatedRoomId,
        "!hookshot gitlab webhook http://gitlab.example.org/my-project",
      );
      expect((await configured).data.content.body).toContain(
        "through its own webhook",
      );
      const { roomId: adminRoomId } = await adminRoomInvite;
      const details = user.waitForRoomEvent<MessageEventContent>({
        eventType: "m.room.message",
        sender: testEnv.botMxid,
        roomId: adminRoomId,
      });
      await user.joinRoom(adminRoomId);
      const lines = (await details).data.content.body.split("\n");
      const webhookUrl = lines[2];
      const webhookSecret = lines[4];
      expect(webhookUrl).toMatch(
        new RegExp(
          `^http://localhost:${webhooksPort}/gitlab/webhook/[0-9a-f-]{36}$`,
        ),
      );
      expect(webhookSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(webhookSecret).not.toEqual(sharedSecret);

      // Collect everything the bot posts from here on.
      const received: Record<string, string[]> = {
        [dedicatedRoomId]: [],
        [sharedRoomId]: [],
      };
      user.on("room.message", (roomId: string, event: any) => {
        if (event.sender === testEnv.botMxid && roomId in received) {
          received[roomId].push(event.content.body);
        }
      });
      const settle = () => new Promise((r) => setTimeout(r, 1000));

      // 1. Dedicated webhook, right secret: only room A.
      let res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "x-gitlab-token": webhookSecret,
          "Content-Type": "application/json",
        },
        body: mergeRequestEvent("Via dedicated"),
      });
      expect(res.status).toBe(200);
      await waitFor(async () => received[dedicatedRoomId].length === 1);
      await settle();
      expect(received[dedicatedRoomId][0]).toContain("Via dedicated");
      expect(received[sharedRoomId]).toHaveLength(0);

      // 2. Shared webhook: only room B.
      res = await fetch(`http://localhost:${webhooksPort}/gitlab/webhook`, {
        method: "POST",
        headers: {
          "x-gitlab-token": sharedSecret,
          "Content-Type": "application/json",
        },
        body: mergeRequestEvent("Via shared"),
      });
      expect(res.status).toBe(200);
      await waitFor(async () => received[sharedRoomId].length === 1);
      await settle();
      expect(received[sharedRoomId][0]).toContain("Via shared");
      expect(received[dedicatedRoomId]).toHaveLength(1);

      // 3. Dedicated webhook with the shared secret, or a wrong one: nowhere.
      for (const token of [sharedSecret, "wrong"]) {
        res = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "x-gitlab-token": token,
            "Content-Type": "application/json",
          },
          body: mergeRequestEvent("Wrong secret"),
        });
        expect(res.status).toBe(200);
      }
      await settle();
      expect(received[dedicatedRoomId]).toHaveLength(1);
      expect(received[sharedRoomId]).toHaveLength(1);

      // 4. Running the command again sends the same details again.
      const again = user.waitForRoomEvent<MessageEventContent>({
        eventType: "m.room.message",
        sender: testEnv.botMxid,
        roomId: adminRoomId,
      });
      await user.sendText(
        dedicatedRoomId,
        "!hookshot gitlab webhook http://gitlab.example.org/my-project",
      );
      const againLines = (await again).data.content.body.split("\n");
      expect(againLines[2]).toEqual(webhookUrl);
      expect(againLines[4]).toEqual(webhookSecret);
    },
    E2ESetupTestTimeout,
  );
});
