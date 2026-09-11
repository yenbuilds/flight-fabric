# AI Use

Flight Fabric uses AI for code, tests, documentation, research, and review.

AI is a tool, not a replacement for human judgement. If you submit or merge a change, know what it does, review it, test it sensibly, and check any claims, sources, and third-party code.

The aircraft support workbench helps developers and coding assistants inspect
implemented mappings, compare changes, and collect selected simulator readings
for manual verification. It runs locally without an LLM connection or API key,
does not learn new aircraft mappings automatically, and does not send reports or
captures to an AI service. Ordinary app users do not need to run it.

Sharing a report or capture with an AI coding service is a separate action.
Review the file first, including its setup notes and source references. Generated
reports, automated tests, and completed captures do not replace vendor evidence
or live cockpit verification. The source-build instructions in [README.md](README.md#build-from-source)
include the workbench command reference.
