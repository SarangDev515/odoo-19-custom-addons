import base64
from io import BytesIO
import pytz
import xlsxwriter
from odoo import fields, models

HEADERS = ['Lead / Opportunity', 'Customer (current)', 'Company (current)',
           'Salesperson (current)', 'Expected Closing', 'From Stage', 'To Stage', 'Changed At', 'Chatter Author']
KEYS = ['lead', 'customer', 'company', 'salesperson', 'expected_closing', 'from_stage', 'to_stage', 'changed_at', 'author']


class StageReportExport(models.TransientModel):
    _name = 'crm.stage.report.export'
    _description = 'CRM stage report download'
    _transient_max_hours = 1

    column_keys = fields.Json(readonly=True, default=lambda self: list(KEYS))
    rows_data = fields.Json(readonly=True)
    date_label = fields.Char(readonly=True)
    search_label = fields.Char(readonly=True)
    file_data = fields.Binary(readonly=True, attachment=False)
    file_name = fields.Char(readonly=True)

    def _display_values(self, row):
        values = [str(row.get(key) or '') for key in KEYS]
        if row.get('expected_closing'):
            values[KEYS.index('expected_closing')] = fields.Date.to_date(row['expected_closing']).strftime('%d/%m/%Y')
        if row.get('changed_at'):
            dt = fields.Datetime.to_datetime(row['changed_at'])
            tz = pytz.timezone(self.env.user.tz or 'UTC')
            values[KEYS.index('changed_at')] = pytz.UTC.localize(dt).astimezone(tz).strftime('%d/%m/%Y %H:%M:%S')
        return values

    def _merged_rows(self, rows):
        result = [{'values': self._display_values(row), 'spans': [1] * len(KEYS)} for row in rows]

        def customer_key(row):
            # Match the JS boundary rule and never group customers by name.
            if row.get('customer_id'):
                return ('customer', row['customer_id'])
            return ('unassigned-lead', row.get('lead_id'))

        for col in range(len(KEYS)):
            pos = 0
            while pos < len(rows):
                end = pos + 1
                customer = customer_key(rows[pos])
                key = rows[pos].get('lead_id') if col == 0 else result[pos]['values'][col]
                while end < len(rows):
                    if customer_key(rows[end]) != customer:
                        break
                    # Descriptive and stage cells repeat for each distinct lead.
                    if KEYS[col] in ('customer', 'company', 'salesperson', 'from_stage', 'to_stage', 'author') and rows[end].get('lead_id') != rows[pos].get('lead_id'):
                        break
                    other = rows[end].get('lead_id') if col == 0 else result[end]['values'][col]
                    if key != other:
                        break
                    end += 1
                result[pos]['spans'][col] = end - pos
                for index in range(pos + 1, end):
                    result[index]['spans'][col] = 0
                pos = end
        return result

    def _column_indexes(self):
        selected = self.column_keys if self.column_keys is not False and self.column_keys is not None else KEYS
        return [index for index, key in enumerate(KEYS) if key in selected] or list(range(len(KEYS)))

    def _column_headers(self):
        return [HEADERS[index] for index in self._column_indexes()]

    def _visible_merged_rows(self, rows):
        indexes = self._column_indexes()
        return [{'values': [row['values'][i] for i in indexes],
                 'spans': [row['spans'][i] for i in indexes]} for row in self._merged_rows(rows)]

    def _pdf_rows(self):
        self.ensure_one()
        merged = self._visible_merged_rows(self.rows_data or [])
        # Remove HTML rows with no visible cell starts after hiding columns.
        # Retain every row that starts a visible cell, including blank values.
        kept = [index for index, row in enumerate(merged) if any(row['spans'])]
        prefix = [0]
        for row in merged:
            prefix.append(prefix[-1] + bool(any(row['spans'])))
        return [{'values': merged[index]['values'],
                 'spans': [prefix[index + span] - prefix[index] if span else 0
                           for span in merged[index]['spans']]}
                for index in kept]

    def _pdf_pages(self):
        # Compatibility for cached templates; the renderer handles real pages.
        return [self._pdf_rows()]

    def _create_xlsx(self):
        self.ensure_one()
        stream = BytesIO()
        workbook = xlsxwriter.Workbook(stream, {'in_memory': True, 'strings_to_formulas': False,
                                                'strings_to_urls': False})
        title = workbook.add_format({'bold': True, 'font_size': 18, 'align': 'center'})
        heading = workbook.add_format({'bold': True, 'bg_color': '#E9E3F0', 'border': 1,
                                       'text_wrap': True, 'valign': 'vcenter'})
        cell = workbook.add_format({'border': 1, 'valign': 'vcenter', 'text_wrap': True})
        rows = self.rows_data or []
        indexes = self._column_indexes()
        headers = self._column_headers()
        last_col = len(indexes) - 1
        report = workbook.add_worksheet('Stage Changes')
        def full_width(row, text, fmt):
            if last_col:
                report.merge_range(row, 0, row, last_col, text, fmt)
            else:
                report.write_string(row, 0, text, fmt)
        full_width(0, 'CRM Stage Change Report', title)
        full_width(1, self.date_label or '', cell)
        full_width(2, 'Search: ' + (self.search_label or 'All generated rows'), cell)
        report.write_row(4, 0, headers, heading)
        merged = self._visible_merged_rows(rows)
        for index, row in enumerate(merged, start=5):
            for col, value in enumerate(row['values']):
                span = row['spans'][col]
                if span > 1:
                    report.merge_range(index, col, index + span - 1, col, value, cell)
                elif span == 1:
                    report.write_string(index, col, value, cell)
        if not rows:
            full_width(5, 'No matching stage changes', cell)
        report.freeze_panes(5, 1)
        report.set_landscape()
        report.fit_to_pages(1, 0)
        report.repeat_rows(4)
        report.set_column(0, last_col, 25)
        report.set_row(0, 28)
        report.set_row(4, 30)
        # Preserve unmerged source rows for sorting/filtering and auditability.
        data = workbook.add_worksheet('Data')
        data.write_row(0, 0, headers, heading)
        for index, row in enumerate(rows, start=1):
            values = self._display_values(row)
            for col, source_col in enumerate(indexes):
                data.write_string(index, col, values[source_col], cell)
        data.freeze_panes(1, 0)
        data.set_column(0, last_col, 25)
        if rows:
            data.autofilter(0, 0, len(rows), last_col)
        notes = workbook.add_worksheet('Notes')
        notes.set_column(0, 0, 110)
        for index, note in enumerate([
            'Existing CRM stage-change chatter; no reconstructed or invented events.',
            'Dates are DD/MM/YYYY in the exporting user timezone; times use 24-hour format.',
            'Customer, company, lead title, salesperson and expected closing are current metadata, refreshed at export.',
            'Chatter author is not guaranteed to be the user who performed the stage write.',
            'Stage Changes merges adjacent equal cells only within the same customer ID; Data preserves every row unmerged.',
            'Export rechecks lead/message access. Source row count: %s' % len(rows),
            'Only selected columns are included in both report and Data sheets.',
            self.date_label or '', 'Search: ' + (self.search_label or 'None')]):
            notes.write_string(index, 0, note)
        workbook.close()
        self.write({'file_data': base64.b64encode(stream.getvalue()),
                    'file_name': 'crm-stage-changes.xlsx'})
