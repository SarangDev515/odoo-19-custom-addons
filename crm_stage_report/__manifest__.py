{
    'name': 'CRM Stage Change Report',
    'version': '19.0.1.1.0',
    'category': 'Sales/CRM',
    'license': 'LGPL-3',
    'author': 'SARANG T',
    'depends': ['crm', 'web', 'mail'],
    "images": ["static/description/banner.png"],
    'data': ['security/ir.model.access.csv', 'report/crm_stage_report_pdf.xml', 'views/crm_stage_report_menu.xml'],
    'assets': {
        'web.assets_backend': [
            'crm_stage_report/static/src/js/crm_stage_report.js',
            'crm_stage_report/static/src/xml/crm_stage_report.xml',
            'crm_stage_report/static/src/css/crm_stage_report.css',
        ],
    },
    'external_dependencies': {'python': ['xlsxwriter']},
    'installable': True,
    'application': False,
}
