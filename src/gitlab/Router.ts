import { Request, Response, Router, json } from "express";
import { MessageQueue } from "../messageQueue";
import { ApiError, ErrCode } from "../api";
import { Logger } from "matrix-appservice-bridge";
import {
  GITLAB_DEDICATED_WEBHOOK_KEY,
  IGitLabWebhookEvent,
  IGitLabWebhookIssueStateEvent,
  IGitLabWebhookMREvent,
  IGitLabWebhookReleaseEvent,
} from "./WebhookTypes";
import { BridgeConfigGitLab } from "../config/sections";

const log = new Logger("GitLabWebhooksRouter");
const DEDICATED_WEBHOOK_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface OAuthPageParams {
  service?: string;
  result?: string;
  "oauth-kind"?: "account" | "organisation";
  error?: string;
  errcode?: ErrCode;
}

export class GitLabWebhooksRouter {
  public static IsRequest(req: Request): boolean {
    return !!req.headers["x-gitlab-token"];
  }

  constructor(
    private readonly config: BridgeConfigGitLab,
    private readonly queue: MessageQueue,
  ) {}

  private payloadHandler(body: IGitLabWebhookEvent) {
    if (body.object_kind === "merge_request") {
      const action = (body as unknown as IGitLabWebhookMREvent)
        .object_attributes.action;
      if (!action) {
        log.warn(
          "Got gitlab.merge_request but no action field, which usually means someone pressed the test webhooks button.",
        );
        return null;
      }
      return `gitlab.merge_request.${action}`;
    } else if (body.object_kind === "issue") {
      const action = (body as unknown as IGitLabWebhookIssueStateEvent)
        .object_attributes.action;
      if (!action) {
        log.warn(
          "Got gitlab.issue but no action field, which usually means someone pressed the test webhooks button.",
        );
        return null;
      }
      return `gitlab.issue.${action}`;
    } else if (body.object_kind === "note") {
      return `gitlab.note.created`;
    } else if (body.object_kind === "tag_push") {
      return "gitlab.tag_push";
    } else if (body.object_kind === "wiki_page") {
      return "gitlab.wiki_page";
    } else if (body.object_kind === "release") {
      const action = (body as unknown as IGitLabWebhookReleaseEvent).action;
      if (!action) {
        log.warn(
          "Got gitlab.release but no action field, which usually means someone pressed the test webhooks button.",
        );
        return null;
      }
      return `gitlab.release.${action}`;
    } else if (body.object_kind === "push") {
      return `gitlab.push`;
    } else {
      return null;
    }
  }

  public verifyRequest(req: Request): void {
    if (typeof req.headers["x-gitlab-token"] !== "string") {
      throw new ApiError(
        "Could not handle GitHub request. Unexpected multiple headers for x-hub-signature-256",
        ErrCode.BadValue,
      );
    }
    if (req.headers["x-gitlab-token"] !== this.config.webhook.secret) {
      throw new ApiError(
        "Could not handle GitLab request. Token did not match.",
        ErrCode.BadValue,
      );
    }
  }

  /**
   * A dedicated webhook belongs to a single connection and is checked against
   * that connection's own secret when the event is routed, not against the
   * shared secret here.
   */
  public verifyDedicatedRequest(req: Request): void {
    if (typeof req.headers["x-gitlab-token"] !== "string") {
      throw new ApiError(
        "Could not handle GitLab request. Missing or repeated X-Gitlab-Token header.",
        ErrCode.BadValue,
      );
    }
  }

  public onDedicatedWebhook(req: Request, res: Response) {
    const id = req.params.id;
    if (typeof id !== "string" || !DEDICATED_WEBHOOK_ID.test(id)) {
      res.status(404).send("Unknown webhook");
      return;
    }
    res.send("OK");
    const eventName = this.payloadHandler(req.body);
    if (eventName) {
      this.queue
        .push({
          eventName,
          sender: "GithubWebhooks",
          data: {
            ...req.body,
            [GITLAB_DEDICATED_WEBHOOK_KEY]: {
              id,
              token: req.headers["x-gitlab-token"],
            },
          },
        })
        .catch((err) => {
          log.error(`Failed to emit payload: ${err}`);
        });
    }
  }

  public onWebhook(req: Request, res: Response) {
    res.send("OK");
    const eventName = this.payloadHandler(req.body);
    if (eventName) {
      this.queue
        .push({
          eventName,
          sender: "GithubWebhooks",
          data: req.body,
        })
        .catch((err) => {
          log.error(`Failed to emit payload: ${err}`);
        });
    }
  }

  public getRouter() {
    const router = Router();
    router.post(
      "/webhook",
      json({ verify: this.verifyRequest.bind(this) }),
      this.onWebhook.bind(this),
    );
    router.post(
      "/webhook/:id",
      json({ verify: this.verifyDedicatedRequest.bind(this) }),
      this.onDedicatedWebhook.bind(this),
    );
    return router;
  }
}
