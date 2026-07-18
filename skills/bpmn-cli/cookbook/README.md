# bpmn-cli cookbook

These recipes are agent workflows, not a second command reference. Begin with
the [`SKILL.md`](../SKILL.md) operating rules and use `--json` for all
machine decisions.

| Recipe | Use when |
| --- | --- |
| [Inspect and diagnose](inspect-and-diagnose.md) | You need semantic context or need to explain a lint finding. |
| [Rename an element](rename-element.md) | You need a low-risk attribute change. |
| [Insert an activity](insert-activity.md) | You need to split a SequenceFlow safely. |
| [Extension data](extension-data.md) | You need Zeebe or custom moddle configuration. |
| [Review, apply, and verify](review-apply-verify.md) | You need the preview-to-publication process. |

Schema-valid request examples are in [`examples/edit`](../../../examples/edit).
