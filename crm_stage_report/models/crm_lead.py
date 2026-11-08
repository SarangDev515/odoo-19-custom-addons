from datetime import datetime, time, timedelta
import pytz
from odoo import api, fields, models, _
from odoo.exceptions import AccessError, ValidationError
from .report_export import KEYS


class CrmLead(models.Model):
    _inherit = 'crm.lead'

    @api.model
    def get_stage_change_report(self, filters=None, cursor=0, limit=500):
        # Public RPC: never trust domains, IDs, limits, or company IDs from JS.
        if not (self.env.user.has_group('sales_team.group_sale_salesman')
                or self.env.user.has_group('sales_team.group_sale_manager')):
            raise AccessError(_('CRM access is required.'))
        if not isinstance(filters, dict):
            raise ValidationError(_('Invalid report filters.'))
        try:
            date_from = fields.Date.to_date(filters.get('date_from'))
            date_to = fields.Date.to_date(filters.get('date_to'))
            company_id = int(filters.get('company_id') or 0)
            partner_ids = filters.get('partner_ids')
            if partner_ids is None:
                # Compatibility with an already-open single-customer client.
                partner_id = int(filters.get('partner_id') or 0)
                partner_ids = [partner_id] if partner_id else []
            if not isinstance(partner_ids, list) or any(
                type(partner_id) is not int or partner_id <= 0
                for partner_id in partner_ids
            ):
                raise ValidationError(_('Invalid customer selection.'))
            from_stage = int(filters.get('from_stage_id') or 0)
            to_stage = int(filters.get('to_stage_id') or 0)
            cursor = int(cursor or 0)
            limit = min(max(int(limit), 1), 500)
        except (TypeError, ValueError, OverflowError):
            raise ValidationError(_('Invalid report parameters.'))
        if not date_from or not date_to or date_from > date_to:
            raise ValidationError(_('Enter a valid inclusive date range.'))
        if (date_to - date_from).days > 366:
            raise ValidationError(_('Use a date range of at most 367 days.'))
        if company_id and company_id not in self.env.companies.ids:
            raise AccessError(_('Select an active authorized company.'))
        if cursor < 0 or from_stage < 0 or to_stage < 0:
            raise ValidationError(_('Invalid report parameters.'))
        try:
            tz = pytz.timezone(self.env.user.tz or 'UTC')
            start = tz.localize(datetime.combine(date_from, time.min))
            end = tz.localize(datetime.combine(date_to + timedelta(days=1), time.min))
        except (ValueError, OverflowError, pytz.UnknownTimeZoneError):
            raise ValidationError(_('Invalid date range or user timezone.'))
        start = fields.Datetime.to_string(start.astimezone(pytz.UTC).replace(tzinfo=None))
        end = fields.Datetime.to_string(end.astimezone(pytz.UTC).replace(tzinfo=None))

        # Search WITHOUT sudo: CRM ACLs, record rules, and companies apply.
        lead_domain = [('company_id', 'in', self.env.companies.ids + [False])]
        if company_id:
            lead_domain = [('company_id', '=', company_id)]
        if partner_ids:
            lead_domain.append(('partner_id', 'in', partner_ids))
        leads = self.with_context(active_test=False).search(lead_domain)
        if not leads:
            return {'rows': [], 'next_cursor': False}
        # sudo is narrowly confined to one known CRM tracking field.
        stage_field = self.env['ir.model.fields'].sudo().search([
            ('model', '=', 'crm.lead'), ('name', '=', 'stage_id')], limit=1)
        if not stage_field:
            raise ValidationError(_('CRM stage field was not found.'))
        domain = [
            ('field_id', '=', stage_field.id),
            ('mail_message_id.model', '=', 'crm.lead'),
            ('mail_message_id.res_id', 'in', leads.ids),
            ('mail_message_id.date', '>=', start),
            ('mail_message_id.date', '<', end),
        ]
        if cursor:
            domain.append(('id', '<', cursor))
        if from_stage:
            domain.append(('old_value_integer', '=', from_stage))
        if to_stage:
            domain.append(('new_value_integer', '=', to_stage))
        tracks = self.env['mail.tracking.value'].sudo().search(
            domain, order='id desc', limit=limit + 1)
        page = tracks[:limit]
        rows = self._stage_report_rows(page)
        return {'rows': rows, 'next_cursor': page[-1].id if len(tracks) > limit else False}

    def _stage_report_rows(self, page):
        # Do not use sudo to bypass message-specific read restrictions.
        message_ids = page.mapped('mail_message_id').ids
        self.env['mail.message'].browse(message_ids).check_access('read')
        selected_ids = list(set(page.mapped('mail_message_id.res_id')))
        # Re-check lead access immediately before returning data.
        selected = self.with_context(active_test=False).browse(selected_ids)
        selected.check_access('read')
        lead_map = {lead.id: lead for lead in selected}
        rows = []
        for track in page:
            message = track.mail_message_id
            lead = lead_map[message.res_id]
            rows.append({
                'id': track.id,
                'lead_id': lead.id,
                'lead': lead.display_name,
                'customer_id': lead.partner_id.id or False,
                'customer': lead.partner_id.display_name or '',
                'salesperson': lead.user_id.display_name or '',
                'expected_closing': fields.Date.to_string(lead.date_deadline) if lead.date_deadline else '',
                'company': lead.company_id.display_name or '',
                'from_stage': track.old_value_char or '(No stage)',
                'to_stage': track.new_value_char or '(No stage)',
                'changed_at': fields.Datetime.to_string(message.date),
                # Chatter author is a partner, NOT necessarily the write user.
                'author': message.author_id.display_name or message.email_from or '',
            })
        return rows

    @api.model
    def export_stage_change_report(self, tracking_ids, file_type='xlsx', date_label='', search_label='', column_keys=None):
        if not (self.env.user.has_group('sales_team.group_sale_salesman')
                or self.env.user.has_group('sales_team.group_sale_manager')):
            raise AccessError(_('CRM access is required.'))
        if column_keys is None:
            column_keys = list(KEYS)
        if (not isinstance(column_keys, list) or not column_keys
                or any(not isinstance(key, str) or key not in KEYS for key in column_keys)
                or len(set(column_keys)) != len(column_keys)):
            raise ValidationError(_('Select at least one valid report column.'))
        column_keys = [key for key in KEYS if key in column_keys]
        if file_type not in ('xlsx', 'pdf'):
            raise ValidationError(_('Unsupported export format.'))
        if not isinstance(tracking_ids, list) or len(tracking_ids) > 10000:
            raise ValidationError(_('Export at most 10,000 stage changes.'))
        if any(type(value) is not int or value <= 0 for value in tracking_ids):
            raise ValidationError(_('Invalid tracking IDs.'))
        if len(set(tracking_ids)) != len(tracking_ids):
            raise ValidationError(_('Duplicate tracking IDs.'))
        if not isinstance(date_label, str) or not isinstance(search_label, str):
            raise ValidationError(_('Invalid report labels.'))
        leads = self.with_context(active_test=False).search([
            ('company_id', 'in', self.env.companies.ids + [False])])
        tracks = self.env['mail.tracking.value'].sudo().search([
            ('id', 'in', tracking_ids),
            ('field_id.model', '=', 'crm.lead'), ('field_id.name', '=', 'stage_id'),
            ('mail_message_id.model', '=', 'crm.lead'),
            ('mail_message_id.res_id', 'in', leads.ids)], order='id desc')
        if set(tracks.ids) != set(tracking_ids):
            raise AccessError(_('Some history was removed or is no longer accessible. Generate the report again.'))
        rows = self._order_stage_report_rows(self._stage_report_rows(tracks))
        report = self.env['crm.stage.report.export'].create({
            'rows_data': rows, 'date_label': date_label[:200], 'search_label': search_label[:500],
            'column_keys': column_keys,
        })
        if file_type == 'pdf':
            # This custom report does not need the company layout setup wizard.
            action = self.env.ref('crm_stage_report.action_stage_report_pdf').report_action(
                report, config=False)
            action['download_url'] = '/report/pdf/%s/%s' % (action['report_name'], report.id)
            return action
        report._create_xlsx()
        return {'type': 'ir.actions.act_url', 'target': 'download',
                'url': '/web/content/crm.stage.report.export/%s/file_data/%s?download=true' % (report.id, report.file_name)}

    def _order_stage_report_rows(self, rows):
        # Match the JS hierarchy: customer -> lead -> newest stage changes.
        chronological = sorted(rows, key=lambda row: (row.get('changed_at') or '', row['id']), reverse=True)
        customers = {}
        for row in chronological:
            customer = (('customer', row['customer_id']) if row.get('customer_id')
                        else ('unassigned-lead', row['lead_id']))
            leads = customers.setdefault(customer, {})
            leads.setdefault(row['lead_id'], []).append(row)
        return [row for leads in customers.values() for events in leads.values() for row in events]
