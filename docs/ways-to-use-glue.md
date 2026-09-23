# Ways to use Glue

Four worked examples. Each one shows the situation, what to ask, what Glue does, and what to watch for. The projects and files are made up.

You talk to your assistant in plain language. It chooses the Glue tools. Glue runs only when you mention it; in Codex you can also type `$glue`.

## 1. Stop now, continue later

**The situation.** You have spent an afternoon on a pricing plan with your assistant. You settled on three tiers, dropped a free plan, and still need to decide on annual discounts. The conversation is getting long and you want to stop.

**What to ask.**

> Use Glue to checkpoint this to `notes/pricing-plan.md`. Keep our decisions and reasons, the open questions and the next step. Save `data/competitor-prices.csv` and `data/costs.csv` as evidence.

Once Glue is in use in a conversation, "Checkpoint" on its own is usually enough.

The next day, in a new conversation, possibly in a different app:

> Use Glue to resume the pricing plan. Tell me where we are and what changed.

**What Glue does.**

- On save, it writes `notes/pricing-plan.md` and keeps a revision of it in `.glue/`. It also keeps exact copies of the two CSV files.
- On resume, it returns the saved text. It compares each CSV file with its saved copy and reports `unchanged` or `changed`.
- If you edited `notes/pricing-plan.md` by hand in between, resume says so. The assistant reads your edit before saving over it.

**Watch for.**

- Glue saves what goes into the handoff, not the conversation. Ask for reasons and open questions explicitly if you want them kept.
- Only selected files are checked. If the plan relied on a file you did not select, Glue cannot tell you it changed.

## 2. Revisit a decision when its reason changes

**The situation.** Last month you ruled out a printing supplier. Their minimum order was 3,000 units and you need 1,000. You saved that decision with the quote as evidence. Now the supplier sends a new quote with a minimum of 1,000.

**What to ask.** When you make the decision:

> Use Glue to save this as a decision in `decisions/printing-supplier.md`. Record that we ruled the supplier out because the minimum order was 3,000 and we need 1,000. Note that a lower minimum would be a reason to look again. Save `quotes/supplier-quote.pdf` as evidence.

When the new quote arrives:

> Use Glue to find why we ruled out the printing supplier. Compare the saved reason and evidence with the new quote in `quotes/supplier-quote-new.pdf`, and tell me whether it's worth reconsidering.

**What Glue does.**

- The first save creates a record with kind `decision` and status `active`. The title and scope make it easy to find later.
- `glue_find` matches the words "printing" and "supplier" in the saved title and text.
- Resume returns the recorded reason and the saved quote. The assistant compares that reason with the new quote. That comparison is the assistant's work, not Glue's.
- If you then change the decision, the assistant saves a new revision. The old reasoning stays readable in history.

**Watch for.**

- A changed fact prompts a review. It does not reverse the decision or approve anything by itself.
- Glue does not watch for new quotes. You bring the new fact.
- Search matches words in saved text. The text inside a PDF is usually not searchable, but its file name is. Put the key facts in the handoff itself.

## 3. Carry a lesson into another project

**The situation.** In a newsletter project, a small pilot suggested that shorter subject lines improved open rates. The pilot had 200 recipients and two sends. You are starting a product-launch email project and want to take the lesson with you, limits included.

Your host needs a Glue connection to each project. In Claude Desktop, that means enabling two Glue connectors, one per project folder.

**What to ask.** First, make sure the lesson is saved as a finding with its limits:

> Use Glue to save the subject-line lesson as a finding in `findings/subject-lines.md`. Put its limits in the scope: one newsletter, 200 recipients, two sends, not tested elsewhere.

Then:

> Use Glue to prepare this lesson for the launch project. Keep its limits and origin, show me what would transfer, and propose how to adapt it.

**What Glue does.**

1. **Preview** in the source project shows exactly what would be sent: the handoff text, its record labels, any captures you selected, and a count of what was left out.
2. After you review it, **export** produces a bundle.
3. In the launch project, **preview-import** shows what would arrive, and **import** saves it as a new handoff.

The copy arrives with status `proposed` and provenance `source`. It records its origin project and version. Resume reports `record_proposed` until you decide the lesson applies and mark it `active`.

**Watch for.**

- Review the actual text before export, not only the labels. Private details can sit inside ordinary prose.
- Transfer refuses text that contains file paths, email addresses, URLs with query strings or credentials. The assistant can prepare a cleaned-up version (`derivativeMarkdown`) for you to review.
- A scope that says "project only" or "do not share" blocks transfer.
- The copy is independent. Later changes to the original do not reach it. To compare, ask the assistant to run a transfer `check` with the origin's current version.

## 4. See what a changed file affects

**The situation.** Your launch plan in `plans/launch.md` depends on the supplier decision in `decisions/printing-supplier.md`. The decision has `quotes/quote.pdf` as evidence. The supplier has just sent a revised `quote.pdf`, and you saved it over the old file.

For this to work, the plan must declare the link when it is saved:

> Use Glue to save the launch plan. It depends on the current printing-supplier decision.

The assistant adds a `dependsOn` link from the plan to the decision's current revision.

**What to ask.**

> Use Glue to resume the launch plan. Show which selected files have changed, which linked decisions rely on them, and what we still cannot verify.

**What Glue does.**

- Resume checks the plan's own evidence. Then it follows the link to the decision and checks the decision's evidence.
- It reports `source_changed` for `quotes/quote.pdf`, with `via` showing it was reached through `plans/launch.md`.
- After the assistant reviews the new quote and saves the decision again, resuming the plan reports `saved_revision_changed`. The plan still points at the old decision revision. Save the plan with the new version once you have checked it still holds.

**Watch for.**

- Checks run forward only. Resuming the plan finds the changed quote, because the plan links to the decision. Resuming the decision does not mention the plan. Nothing looks up which other handoffs depend on a changed file.
- Glue checks only selected files and declared links. It cannot discover a dependency nobody declared.
- If `basis.complete` is `false`, some checks could not run. Treat those parts as unchecked.
