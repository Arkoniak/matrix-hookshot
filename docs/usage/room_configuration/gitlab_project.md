# GitLab Project

This connection type connects a GitLab project (e.g. https://gitlab.matrix.org/matrix-org/olm) to a room.

## Setting up

To set up a connection to a GitLab project in a new room:

(NB you must have permission to bridge GitLab repositories before you can use this command, see [auth](../auth.html#gitlab).)

1. Create a new, unencrypted room. It can be public or private.
2. Invite the bridge bot (e.g. `@hookshot:example.com`).
3. Give the bridge bot moderator permissions or higher (power level 50) (or otherwise configure the room so the bot can edit room state).
4. Send the command `!hookshot gitlab project https://mydomain/my/project`.
5. If you have permission to bridge this repo, the bridge will respond with a confirmation message. (Users with `Developer` permissions or greater can bridge projects.)
6. If you have configured the bridge with a `publicUrl` inside `gitlab.webhook` in your [config](../../setup/gitlab.md), you authenticated with Hookshot on that instance in your admin room, and you have `Maintainer` permissions or greater on the project, the bot will automatically provision the webhook for you.
7. Otherwise, you'll need to manually configure the project with a webhook that points to your public address for the webhooks listener, sets the "Secret token" to the one you put in your Hookshot configuration (`gitlab.webhook.secret`), and enables all Triggers that need to be bridged (as Hookshot can only bridge events for enabled Triggers). This can be configured on the GitLab webpage for the project under Settings > Webhook Settings. If you do not have access to this page, you must ask someone who does (i.e. someone with at least `Maintainer` permissions on the project) to add the webhook for you.

### Setting up without a GitLab login

`!hookshot gitlab project` needs you to be logged into GitLab, because the shared webhook delivers a
project's events to every room bridged to that project, so Hookshot must check that you can see it.
If you do not want to give Hookshot a GitLab token, you can instead connect the room through a webhook
that only this room uses. Adding that webhook to the project is what proves access.

This requires `publicUrl` inside `gitlab.webhook` in your [config](../../setup/gitlab.md).

1. Do steps 1–3 above.
2. Send the command `!hookshot gitlab webhook https://mydomain/my/project`.
3. The bot sends a webhook URL and a secret token to your admin room.
4. In the GitLab project, under Settings > Webhooks, add a webhook with that URL and secret token, and
   enable the Triggers you want bridged.

Events sent to this URL reach only this room, and only if the secret token matches. In return, this
room no longer receives the project's events from the shared webhook. Sending the command again in
the same room sends the same URL and secret token again. The webhook mode of a connection cannot be
changed later: remove the connection and create it again.

## Configuration

This connection supports a few options which can be defined in the room state[^2]:

| Option             | Description                                                         | Allowed values                                            | Default                                      |
| ------------------ | ------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| commandPrefix      | Choose the prefix to use when sending commands to the bot           | A string, ideally starts with "!"                         | `!gh`                                        |
| enableHooks [^1]   | Enable notifications for some event types                           | Array of: [Supported event types](#supported-event-types) | If not defined, defaults are mentioned below |
| excludingLabels    | Never notify on issues matching these label names                   | Array of: String matching a label name                    | _empty_                                      |
| ignoreHooks [^1]   | **deprecated** Choose to exclude notifications for some event types | Array of: [Supported event types](#supported-event-types) | _empty_                                      |
| includeCommentBody | Include the body of a comment when notifying on merge requests      | Boolean                                                   | false                                        |
| includingLabels    | Only notify on issues matching these label names                    | Array of: String matching a label name                    | _empty_                                      |
| pushTagsRegex      | Only mention pushed tags which match this regex                     | Regex string                                              | _empty_                                      |

[^1]: `ignoreHooks` is no longer accepted for new state events. Use `enableHooks` to explicitly state all events you want to see.

[^2]: To change room state with Element Web/Desktop: open devtools by typing `/devtools` + enter in the chat box, and click on "Explore room state". Next, choose `uk.half-shot.matrix-hookshot.gitlab.repository`. You'll then be able to see and edit (if you have the required permissions) the settings by setting properties on the JSON object directly.

### Supported event types

This connection supports sending messages when the following actions happen on the repository.

Note: Some of these event types are enabled by default (marked with a `*`). When `ignoreHooks` _is_ defined,
the events marked as default below will be enabled. Otherwise, this is ignored.

- merge_request \*
  - merge_request.close \*
  - merge_request.merge \*
  - merge_request.open \*
  - merge_request.reopen \*
  - merge_request.review.comments \*
  - merge_request.review \*
  - merge_request.review.individual
- push \*
- release \*
  - release.created \*
- tag_push \*
- wiki \*
- pipeline \*
  - pipeline.running \*
  - pipeline.success \*
  - pipeline.failed \*
  - pipeline.canceled \*
  - pipeline.manual \*

Pipeline notifications name the jobs that matter, with links: the jobs that failed (with GitLab's
failure reason), the manual jobs a pipeline is waiting for, and, after a successful pipeline, manual
jobs that were left unrun (manual jobs with `allow_failure: true` do not block the pipeline).

Pipeline events require the **Pipeline events** trigger on the project's GitLab webhook. Hookshot enables it
when it creates the webhook itself; for a webhook created by hand, or one created by an older version of
Hookshot, enable the trigger in the project's webhook settings.
