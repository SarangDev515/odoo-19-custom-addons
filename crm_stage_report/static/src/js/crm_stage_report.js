/** @odoo-module **/
import { Component, onMounted, onWillStart, onWillUnmount, useRef, useState } from "@odoo/owl";
import { useSetupAction } from "@web/search/action_hook";
import { download } from "@web/core/network/download";
import { Many2XAutocomplete } from "@web/views/fields/relational_utils";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { user } from "@web/core/user";
import { deserializeDate, deserializeDateTime } from "@web/core/l10n/dates";
import { useDateTimePicker } from "@web/core/datetime/datetime_picker_hook";

const COLUMNS = ["Lead / Opportunity", "Customer (current)", "Company (current)",
    "Salesperson (current)", "Expected Closing", "From Stage", "To Stage", "Changed At", "Chatter Author"];

const COLUMN_KEYS = ["lead", "customer", "company", "salesperson", "expected_closing", "from_stage", "to_stage", "changed_at", "author"];
const MAX_ROWS = 10000;

export function isoDay(value) {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value || "");
    if (!match) { throw new Error("Enter dates as DD/MM/YYYY."); }
    const [, d, m, y] = match;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    if (date.getFullYear() !== Number(y) || date.getMonth() + 1 !== Number(m) || date.getDate() !== Number(d)) {
        throw new Error("Enter a valid calendar date as DD/MM/YYYY.");
    }
    return y + "-" + m + "-" + d;
}
export function orderReportRows(rows) {
    // Sort actual UTC timestamps, not formatted dates or tracking IDs alone.
    const chronological = [...rows].sort((a, b) => {
        const timeA = a.changed_at || "";
        const timeB = b.changed_at || "";
        return timeA < timeB ? 1 : timeA > timeB ? -1 : Number(b.id) - Number(a.id);
    });
    const customers = new Map();
    for (const row of chronological) {
        const customer = row.customer_id ? "customer:" + row.customer_id : "unassigned-lead:" + row.lead_id;
        if (!customers.has(customer)) { customers.set(customer, new Map()); }
        const leads = customers.get(customer);
        if (!leads.has(row.lead_id)) { leads.set(row.lead_id, []); }
        leads.get(row.lead_id).push(row);
    }
    // Insertion order ranks customers and leads by their latest change.
    return Array.from(customers.values()).flatMap(leads => Array.from(leads.values()).flat());
}
export function mergeReportRows(rows, values) {
    const merged = rows.map(row => ({ ...row, values: values(row), spans: Array(COLUMNS.length).fill(1) }));
    // Use the actual partner ID: different customers can have identical names.
    // Older cached rows and unassigned leads are kept separate by lead ID.
    const customerKey = row => row.customer_id
        ? "customer:" + row.customer_id
        : "unassigned-lead:" + row.lead_id;
    for (let col = 0; col < COLUMNS.length; col++) {
        let pos = 0;
        while (pos < rows.length) {
            let end = pos + 1;
            const customer = customerKey(rows[pos]);
            const key = col === 0 ? rows[pos].lead_id : merged[pos].values[col];
            while (
                end < rows.length &&
                customerKey(rows[end]) === customer &&
                // Descriptive and stage cells repeat for each distinct lead.
                (![1, 2, 3, 5, 6, 8].includes(col) || rows[end].lead_id === rows[pos].lead_id) &&
                (col === 0 ? rows[end].lead_id : merged[end].values[col]) === key
            ) {
                end++;
            }
            merged[pos].spans[col] = end - pos;
            for (let index = pos + 1; index < end; index++) { merged[index].spans[col] = 0; }
            pos = end;
        }
    }
    return merged;
}
class CrmStageReport extends Component {
    static template = "crm_stage_report.StageChangeReport";
    static props = ["*"];
    static components = { Many2XAutocomplete };
    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");
        this.alive = true;
        this.printFrame = null;
        // User timezone, matching Python's date boundaries.
        const today = deserializeDateTime(new Date().toISOString().slice(0, 19).replace("T", " "));
        const end = today.toFormat("dd/MM/yyyy");
        const start = today.startOf("month").toFormat("dd/MM/yyyy");
        this.tableRef = useRef("tableArea");
        this.state = useState({
            filters: { date_from: start, date_to: end,
                company_id: "", partner_ids: [], from_stage_id: "", to_stage_id: "" },
            selectedPartners: [], companies: [], stages: [], rows: [], search: "", page: 0,
            visibleColumnKeys: [...COLUMN_KEYS], pageSize: 80, ready: false, collapsed: false, error: "", snapshot: null,
            ...(this.props.state?.stageReport || {}),
            loading: false, exporting: false,
        });
        const savedColumns = this.state.visibleColumnKeys;
        this.state.visibleColumnKeys = COLUMN_KEYS.filter(key => Array.isArray(savedColumns) && savedColumns.includes(key));
        if (!this.state.visibleColumnKeys.length) { this.state.visibleColumnKeys = [...COLUMN_KEYS]; }
        const normalizeFilters = (filters) => {
            const { partner_id, ...values } = filters;
            return {
                ...values,
                partner_ids: Array.isArray(values.partner_ids) ? [...values.partner_ids]
                    : partner_id ? [Number(partner_id)] : [],
            };
        };
        this.state.filters = normalizeFilters(this.state.filters);
        // Native Odoo calendars, with read-only inputs so dates are selected, not typed.
        this.datePickers = {};
        const report = this;
        for (const field of ["date_from", "date_to"]) {
            this.datePickers[field] = useDateTimePicker({
                startDateRefName: field,
                format: "dd/MM/yyyy",
                get pickerProps() {
                    const value = report.state.filters[field];
                    return {
                        type: "date",
                        value: value ? deserializeDate(isoDay(value)) : false,
                    };
                },
                onApply: (value) => {
                    if (!report.alive || report.state.loading || report.state.exporting) { return; }
                    if (value?.isValid) {
                        report.state.filters[field] = value.toFormat("dd/MM/yyyy");
                    }
                },
            });
        }
        if (this.state.snapshot) {
            this.state.snapshot = normalizeFilters(this.state.snapshot);
        }
        const savedPartners = new Map(
            (this.state.selectedPartners || []).map(partner => [partner.id, partner])
        );
        this.state.selectedPartners = this.state.filters.partner_ids.map(id =>
            savedPartners.get(id) || { id, name: this.state.partnerName || "Selected customer" }
        );
        this.state.rows = orderReportRows(this.state.rows);
        useSetupAction({ getLocalState: () => ({
            stageReport: JSON.parse(JSON.stringify(this.state)),
            tableScroll: { top: this.tableRef.el?.scrollTop || 0, left: this.tableRef.el?.scrollLeft || 0 },
        }) });
        onMounted(() => {
            if (this.tableRef.el && this.props.state?.tableScroll) {
                this.tableRef.el.scrollTop = this.props.state.tableScroll.top;
                this.tableRef.el.scrollLeft = this.props.state.tableScroll.left;
            }
        });
        onWillStart(async () => {
            try {
                const [companies, stages] = await Promise.all([
                    this.orm.searchRead("res.company", [["id", "in", user.activeCompanies.map(company => company.id)]], ["name"]),
                    this.orm.searchRead("crm.stage", [], ["name"], { order: "sequence, id" }),
                ]);
                if (this.alive) {
                    this.state.companies = companies;
                    this.state.stages = stages;
                }
            } catch (error) {
                this.state.error = error.message || "Unable to load filters.";
            }
        });
        onWillUnmount(() => {
            this.alive = false;
            this.printFrame?.remove();
        });
    }
    datePickerKeydown(ev, field) {
        if (["Enter", " ", "ArrowDown"].includes(ev.key)) {
            ev.preventDefault();
            this.openDatePicker(field);
        }
    }
    openDatePicker(field) {
        if (this.state.loading || this.state.exporting) { return; }
        this.datePickers[field]?.open(0);
    }
    getPartnerDomain() {
        return [["id", "not in", this.state.filters.partner_ids]];
    }
    async updatePartner(records) {
        if (this.state.loading || this.state.exporting || !records?.length) { return; }
        try {
            const ids = [...new Set(records.map(record => Number(record.id)))]
                .filter(id => Number.isInteger(id) && id > 0);
            if (!ids.length) { return; }
            const partners = await this.orm.read("res.partner", ids, ["display_name"]);
            if (!this.alive || this.state.loading || this.state.exporting) { return; }
            const selected = new Map(
                this.state.selectedPartners.map(partner => [partner.id, partner])
            );
            for (const partner of partners) {
                selected.set(partner.id, { id: partner.id, name: partner.display_name });
            }
            this.state.selectedPartners = [...selected.values()];
            this.state.filters.partner_ids = [...selected.keys()];
        } catch (error) {
            if (this.alive) {
                this.notification.add(error.message || "Unable to read customers.", { type: "warning" });
            }
        }
    }
    removePartner(partnerId) {
        if (this.state.loading || this.state.exporting) { return; }
        this.state.selectedPartners = this.state.selectedPartners.filter(partner => partner.id !== partnerId);
        this.state.filters.partner_ids = this.state.filters.partner_ids.filter(id => id !== partnerId);
    }
    clearPartners() {
        if (this.state.loading || this.state.exporting) { return; }
        this.state.selectedPartners = [];
        this.state.filters.partner_ids = [];
    }
    columnMenuKeydown(ev) {
        if (ev.key === "Escape") { ev.currentTarget.removeAttribute("open"); }
    }
    get columns() {
        return COLUMNS.map((label, index) => ({ label, index, key: COLUMN_KEYS[index] }));
    }
    get visibleColumns() { return this.columns.filter(col => this.isColumnVisible(col.index)); }
    isColumnVisible(index) { return this.state.visibleColumnKeys.includes(COLUMN_KEYS[index]); }
    toggleColumn(key, ev) {
        if (this.state.exporting || this.state.loading) { return; }
        const selected = new Set(this.state.visibleColumnKeys);
        if (ev.target.checked) { selected.add(key); } else { selected.delete(key); }
        if (!selected.size) {
            ev.target.checked = true;
            this.notification.add("Keep at least one column selected.", { type: "warning" });
            return;
        }
        this.state.visibleColumnKeys = COLUMN_KEYS.filter(key => selected.has(key));
    }
    showAllColumns() { this.state.visibleColumnKeys = [...COLUMN_KEYS]; }
    get filteredRows() {
        const query = this.state.search.trim().toLocaleLowerCase();
        return query ? this.state.rows.filter(row => this.values(row).join(" ").toLocaleLowerCase().includes(query)) : this.state.rows;
    }
    get pageRows() {
        return this.filteredRows.slice(this.state.page * this.state.pageSize, (this.state.page + 1) * this.state.pageSize);
    }
    get tableRows() { return mergeReportRows(this.pageRows, row => this.values(row)); }
    get pageCount() { return Math.max(1, Math.ceil(this.filteredRows.length / this.state.pageSize)); }
    get dirty() {
        return this.state.ready && JSON.stringify(this.state.filters) !== JSON.stringify(this.state.snapshot);
    }
    formatDate(value) {
        return value ? deserializeDateTime(value).toFormat("dd/MM/yyyy HH:mm:ss") : "";
    }
    values(row) {
        return [row.lead, row.customer, row.company, row.salesperson,
            row.expected_closing ? deserializeDate(row.expected_closing).toFormat("dd/MM/yyyy") : "",
            row.from_stage, row.to_stage, this.formatDate(row.changed_at), row.author];
    }
    searchChanged(ev) { this.state.search = ev.target.value; this.state.page = 0; }
    pageSizeChanged(ev) { this.state.pageSize = Number(ev.target.value); this.state.page = 0; }
    previous() { this.state.page = Math.max(0, this.state.page - 1); }
    next() { this.state.page = Math.min(this.pageCount - 1, this.state.page + 1); }
    toggleFilters() { this.state.collapsed = !this.state.collapsed; }
    async loadReport() {
        if (this.state.loading || this.state.exporting) { return; }
        const snapshot = {
            ...this.state.filters,
            partner_ids: [...this.state.filters.partner_ids],
        };
        let filters;
        try {
            filters = { ...snapshot, date_from: isoDay(snapshot.date_from), date_to: isoDay(snapshot.date_to) };
            if (filters.date_from > filters.date_to) { throw new Error("From date must not be later than To date."); }
        } catch (error) {
            this.notification.add(error.message, { type: "warning" }); return;
        }
        this.state.loading = true;
        this.state.ready = false;
        this.state.rows = [];
        this.state.error = "";
        try {
            const rows = [];
            let cursor = 0;
            do {
                const result = await this.orm.call("crm.lead", "get_stage_change_report", [], {
                    filters, cursor, limit: 500,
                });
                if (!this.alive) { return; }
                rows.push(...result.rows);
                cursor = result.next_cursor;
                if (rows.length > MAX_ROWS || (rows.length === MAX_ROWS && cursor)) {
                    throw new Error("More than 10,000 changes match. Narrow the date, company, or stage filters. No partial report has been generated.");
                }
            } while (cursor);
            this.state.rows = orderReportRows(rows);
            this.state.snapshot = snapshot;
            this.state.page = 0;
            this.state.ready = true;
        } catch (error) {
            if (this.alive) { this.state.error = error.message || "Unable to read stage history."; }
        } finally {
            if (this.alive) { this.state.loading = false; }
        }
    }
    openLead(ev) {
        this.action.doAction({ type: "ir.actions.act_window", res_model: "crm.lead",
            res_id: Number(ev.currentTarget.dataset.id), views: [[false, "form"]], target: "current" });
    }
    async exportXlsx() { await this.downloadExport("xlsx"); }
    async exportPdf() { await this.downloadExport("pdf"); }
    async downloadExport(format) {
        if (!this.state.ready || this.state.loading || this.state.exporting) { return; }
        this.state.exporting = true;
        try {
            const result = await this.orm.call("crm.lead", "export_stage_change_report", [], {
                tracking_ids: this.filteredRows.map(row => row.id), file_type: format,
                date_label: this.state.snapshot.date_from + " to " + this.state.snapshot.date_to,
                search_label: this.state.search,
                column_keys: [...this.state.visibleColumnKeys],
            });
            if (format === "pdf") {
                // Use report/download directly: never fall back to HTML/print preview.
                let url = result.download_url;
                // Compatibility with a standard report action; never join undefined.
                if (!url && result.report_name && Array.isArray(result.context?.active_ids)) {
                    url = "/report/pdf/" + result.report_name + "/" + result.context.active_ids.join(",");
                }
                if (!url || !url.startsWith("/report/pdf/")) {
                    throw new Error("Odoo did not return a PDF download URL. Restart Odoo after updating the module.");
                }
                await download({ url: "/report/download", data: {
                    data: JSON.stringify([url, "qweb-pdf"]), context: JSON.stringify(user.context),
                } });
            } else {
                if (!result.url || !result.url.startsWith("/web/content/")) {
                    throw new Error("Odoo did not return an Excel download URL.");
                }
                // Odoo 19 download() iterates options.data even for an empty POST.
                await download({ url: result.url, data: {} });
            }
        } catch (error) {
            this.notification.add(error.message || "Download failed. Check Odoo's PDF renderer for PDF errors.", { type: "danger", sticky: true });
        } finally {
            if (this.alive) { this.state.exporting = false; }
        }
    }
    printReport() {
        if (!this.state.ready || this.state.loading || this.state.exporting || this.printFrame) { return; }
        const frame = document.createElement("iframe");
        frame.title = "CRM report printing";
        frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1123px;height:794px;border:0";
        document.body.appendChild(frame);
        this.printFrame = frame;
        const cleanup = () => { frame.remove(); if (this.printFrame === frame) { this.printFrame = null; } };
        try {
            const doc = frame.contentDocument;
            // Only constant markup is written; all record data uses textContent.
            doc.open();
            doc.write('<!doctype html><html><head><title>CRM Stage Change Report</title><style>@page{size:A4 landscape;margin:10mm}body{font:11px Arial}h1,p{text-align:center}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:5px;text-align:left}th{background:#eee}thead{display:table-header-group}tr{break-inside:avoid}</style></head><body></body></html>');
            doc.close();
            const add = (parent, tag, text) => { const node = doc.createElement(tag); node.textContent = text; parent.appendChild(node); return node; };
            add(doc.body, "h1", "CRM Stage Change Report");
            add(doc.body, "p", this.state.snapshot.date_from + " to " + this.state.snapshot.date_to + " | " + this.filteredRows.length + " changes");
            if (this.state.search) { add(doc.body, "p", "Search: " + this.state.search); }
            const table = doc.createElement("table"); doc.body.appendChild(table);
            const header = doc.createElement("thead"); table.appendChild(header);
            const tr = doc.createElement("tr"); header.appendChild(tr);
            this.visibleColumns.forEach(col => add(tr, "th", col.label));
            const body = doc.createElement("tbody"); table.appendChild(body);
            mergeReportRows(this.filteredRows, row => this.values(row)).forEach(row => {
                const line = doc.createElement("tr"); body.appendChild(line);
                row.values.forEach((value, col) => {
                    if (this.isColumnVisible(col) && row.spans[col]) { const cell = add(line, "td", value); cell.rowSpan = row.spans[col]; }
                });
            });
            frame.contentWindow.addEventListener("afterprint", cleanup, { once: true });
            setTimeout(() => { if (frame.isConnected) { frame.contentWindow.focus(); frame.contentWindow.print(); } }, 150);
            setTimeout(cleanup, 300000);
        } catch (error) {
            cleanup();
            this.notification.add(error.message || "Printing failed.", { type: "danger" });
        }
    }
}
registry.category("actions").add("crm_stage_report", CrmStageReport);