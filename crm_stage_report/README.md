# CRM Stage Change Report — Odoo 19

## Current behavior

- OWL client action with secured Python reader of existing CRM stage-change chatter. No new stage recorder.
- Opening a lead through its report link, then returning through Odoo Back/breadcrumb navigation, restores rows, input filters, generated filters, search, pagination, filter-panel visibility and table scroll. State is action-local memory; a full browser reload, a new independent menu action or a new login does not promise restoration. Use Get Report to intentionally refresh.
- User-facing dates use DD/MM/YYYY; change timestamps add 24-hour HH:mm:ss. Date filters accept DD/MM/YYYY explicitly and validate actual calendar dates. UTC/ISO remains the server transport format.
- Previous/Next and 40/80/160 rows-per-page options are at the bottom. Search and row count remain above the table.
- Consecutive equal values are vertically merged per column. Lead cells merge by lead ID, not just equal titles. Rows are grouped by customer and lead before adjacent equal cells are merged. Merges reset at each displayed page and each 25-row PDF chunk. Every stage-change row remains present.
- Excel downloads a real .xlsx workbook: Stage Changes (merged presentation), Data (unmerged source rows for sorting/filtering), Notes (method and limits). Strings are never interpreted as spreadsheet formulas or URLs. Workbook output is static report data, not a formula model.
- PDF downloads through Odoo's /report/download route and QWeb PDF renderer; it does not call browser print. A working Odoo wkhtmltopdf renderer is required. Missing PDF support reports a download error rather than silently switching to print preview. Very long cell text and pagination still need checking against the server renderer.
- Print remains a separate browser-print function.
- Exports and Print include all locally search-matching generated rows, not only the visible page. Server exports revalidate lead/message access and refresh current lead metadata; retained tracking IDs must still exist and be accessible.

## Install or upgrade

Back up the database, restart the Odoo service, and upgrade crm_stage_report from Apps/developer mode. An upgrade (not just a browser refresh) is necessary: this update adds a transient export model, its access CSV and a PDF report action. Then hard-refresh the web client.

Alternatively use the existing deployment's odoo-bin command/configuration with -d YOUR_DATABASE -u crm_stage_report --stop-after-init, then start normally. Do not run this against a different database by accident.

XLSXWriter must be available in the Odoo Python environment (declared as an external dependency in the manifest). PDF needs Odoo's supported wkhtmltopdf installation. Test rendering on a development database.

## Security and data limits

Lead searches/final checks run without sudo. Privileged tracking reads are restricted to the CRM stage field and readable leads in active authorized companies (plus shared leads). Linked message read access is checked. Exports repeat these checks. Export records use Odoo TransientModel's per-creator access and automatic cleanup; no global mail tracking permissions are granted.

Existing chatter only: deleted records/history and changes with tracking disabled cannot be reconstructed. Lead name/customer/company/salesperson are current metadata, not historical snapshots. Chatter author does not necessarily identify the actual writer. Date range is at most 367 inclusive days. Loading uses batches of 500 and fails explicitly over 10,000 matched changes. This is not a benchmarked large-dataset implementation.

## Verification

Local regression checks cover date parsing, leap dates, row spans, distinct lead IDs, page boundaries, action-local state round trips, native XLSX reopening and merge metadata, source row counts, hostile formula-like strings, empty exports, PDF chunk preparation, and access/input rejection. Python/XML/JavaScript source checks and OWL template compilation are separate from a full Odoo runtime test.

The current change was not installed/restarted or tested through a signed-in Odoo browser in this session. Check a restricted salesperson, archived leads, multiple active companies, a timezone boundary, lead-open/back navigation, bottom pagination, merged cells and all three outputs in your development instance.

## Customer boundary correction

Adjacent equal cells merge only within the same actual customer (partner ID), including across different leads for that customer. Lead hyperlink cells remain separate for different lead IDs so links stay correct. A different customer always ends every rowspan, even when customer names match. Within the customer/lead order, only consecutive equal cells merge. Unassigned leads are separated by lead ID. This rule is shared by screen/Print and Excel/PDF. Restart Odoo and regenerate the report after this change so cached rows include customer_id.

## Customer / lead / time ordering

The report groups all leads for one customer contiguously. Customers are ordered by their latest recorded change, leads within a customer by each lead's latest change, and events within a lead by actual changed_at descending (tracking ID descending only breaks timestamp ties). Screen, Print, Excel and PDF use the same hierarchy. This is not a globally chronological list across different customers/leads. Different customer IDs with the same display name remain distinct. Grouping is applied after all server batches load; keyset fetching stays unchanged. Groups spanning display/PDF page boundaries repeat their visible merged cell on the new page.

## Customer filter and cleaner header

The filter panel includes a searchable res.partner Customer selector with Search More and a clear action. Selecting a customer filters crm.lead.partner_id exactly (not every child contact of the commercial company). Leave it blank for all customers. The selection is restored with report action state and becomes effective after Get Report; exports use those generated rows. The customer field respects normal partner access and never grants record creation from this selector. The report-header explanatory note and timezone/grouping suffix were removed; the generated date range remains visible. Equivalent explanatory notes were removed from Print/PDF, while the workbook Notes sheet retains methodology.
