export type TelegramLanguage = 'fa' | 'en';

export interface PresentationMetadata {
  language: string;
  timezone: string;
  entitlement?: {
    plan: 'FREE' | 'PRO' | 'AGENCY';
    status: 'ACTIVE' | 'SUSPENDED';
    effectiveState: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED';
    expiresAt: string | null;
  } | null;
}

type InterpolationValues = Readonly<Record<string, string | number>>;
type Diagnostic = (key: string) => void;

const en = {
  'general.privateOnly':
    'This bot can only be used in a private Telegram chat.',
  'general.transientFailure':
    'The service is temporarily unavailable. Return Home or try again shortly.',
  'general.invalidToken':
    'This link token is invalid or expired. Request a new token and try again.',
  'general.expiredList':
    'This view expired or the active context changed. Refresh and try again.',
  'general.unauthorizedOrders':
    'This chat is not authorized to view orders. Check Status for recovery details.',
  'general.noActiveStore':
    'No single active store is available for this chat. Check Status before trying again.',
  'entitlement.requiredSuspended':
    'Service access is suspended. Operational capabilities are unavailable; Status, Help, Settings, and Unlink remain available.',
  'entitlement.requiredExpired':
    'Service access has expired. Operational capabilities are unavailable; Status, Help, Settings, and Unlink remain available.',
  'entitlement.plan': 'Plan: {value}',
  'entitlement.access': 'Service access: {value}',
  'entitlement.expiry': 'Access expiry: {value}',
  'entitlement.noExpiry': 'No expiry',
  'entitlement.settingsInactive':
    'Settings are read-only while service access is inactive.',
  'general.malformedResponse':
    'The service returned an unexpected response. Return Home or try again shortly.',
  'general.unavailable': 'Unavailable',
  'general.none': 'None',
  'general.notConfigured': 'Not configured',
  'general.notManaged': 'Not managed',
  'general.notSpecified': 'Not specified',
  'general.deleted': 'deleted',
  'general.yes': 'Yes',
  'general.no': 'No',
  'home.title': 'WooCommerce Management',
  'home.choose': 'Choose an action.',
  'home.linked': 'Account linked successfully.',
  'status.title': 'Account Status',
  'status.unlinked':
    'This Telegram account is not linked. Use /start <token> to link it.',
  'status.noMembership':
    'Your Telegram account is linked, but no active tenant membership is available.',
  'status.selectionRequired':
    'Your Telegram account is linked. Tenant or store selection is required in a later setup step.',
  'status.ready': 'Your Telegram account is linked and authorized.',
  'status.noStore':
    'Your Telegram account is linked, but no active store context is available.',
  'help.title': 'Help',
  'help.body':
    '/start — Open Home or link with a token\n/orders — Browse recent orders\n/order <number> — Open one exact order number\n/stock — Show low and out-of-stock items\n/search <query> — Search orders and inventory\n/report — Show today’s projected operational summary\n/status — Check account and store access\n/settings — View or manage store settings\n/help — Show this command list\n/unlink — Unlink this Telegram account',
  'help.secureActions':
    'Order details, refresh, status changes, and permitted notes use the secure buttons shown by the bot.',
  'unlink.confirm':
    'Unlink this Telegram account? You will need a new token to link again.',
  'unlink.success': 'Your Telegram account has been unlinked.',
  'unlink.unauthorized': 'This chat is not authorized.',
  'nav.home': 'Home',
  'nav.orders': 'Recent Orders',
  'nav.refreshOrders': 'Refresh Recent Orders',
  'nav.status': 'Status',
  'nav.checkStatus': 'Check Status',
  'nav.help': 'Help',
  'nav.settings': 'Settings',
  'nav.backSettings': 'Back to Settings',
  'nav.stock': 'Stock',
  'nav.refreshStock': 'Refresh Stock',
  'nav.search': 'Search',
  'nav.newSearch': 'New Search',
  'nav.report': 'Daily Report',
  'nav.previous': 'Previous',
  'nav.next': 'Next',
  'nav.backOrder': 'Back to Order',
  'nav.backOrders': 'Back to Orders',
  'nav.backStock': 'Back to Stock',
  'nav.backSearch': 'Back to Search',
  'action.confirm': 'Confirm',
  'action.cancel': 'Cancel',
  'action.confirmUnlink': 'Confirm Unlink',
  'action.changeStatus': 'Change Status',
  'action.refresh': 'Refresh',
  'action.addNote': 'Add Note',
  'action.viewOrder': 'View Order',
  'action.viewStock': 'View Stock',
  'action.setTimezone': 'Set Timezone',
  'action.setThreshold': 'Set Threshold',
  'action.clearThreshold': 'Clear Threshold',
  'action.enable': 'Enable {value}',
  'action.disable': 'Disable {value}',
  'action.select': 'Select {value}',
  'action.remove': 'Remove {value}',
  'settings.title': 'Store Settings',
  'settings.language': 'Language: {value}',
  'settings.timezone': 'Timezone: {value}',
  'settings.threshold': 'Low-stock threshold: {value}',
  'settings.notifications': 'Notifications: {value}',
  'settings.recipients': 'Recipients: {value}',
  'settings.selected':
    'Selected: {selected} • currently available: {available}',
  'settings.selectedManagers': 'Selected managers',
  'settings.unavailableSuffix': ' — unavailable',
  'settings.readOnly': 'Your membership has read-only access to settings.',
  'settings.timezoneReady':
    'Timezone entry is ready. Reply to the new prompt with a canonical IANA timezone.',
  'settings.thresholdReady':
    'Threshold entry is ready. Reply to the new prompt with a non-negative whole number.',
  'settings.timezonePrompt':
    'Reply with a canonical IANA timezone, for example {value}.',
  'settings.thresholdPrompt':
    'Reply with a non-negative whole-number low-stock threshold.',
  'settings.thresholdPlaceholder': 'Enter threshold',
  'settings.reference': 'Settings reference:',
  'settings.forbidden':
    'Your membership can view settings but cannot change them.',
  'settings.unauthorized':
    'This chat is not authorized to view store settings.',
  'settings.invalid':
    'That setting value is invalid. Nothing changed. Reply to the original prompt again or reopen Settings.',
  'settings.expiredInput':
    'This settings input expired or was already used. Nothing changed.',
  'settings.contextChanged':
    'This settings action expired or the active context changed. Nothing changed.',
  'settings.unavailable':
    'Settings are unavailable. Return Home and try again.',
  'stock.title': 'Inventory',
  'stock.syncing':
    'Inventory is synchronizing from the current WooCommerce catalog. Try again shortly.',
  'stock.syncFailed':
    'The previous inventory synchronization did not complete. Recovery has been queued; try again shortly.',
  'stock.expired': 'This stock view expired or the active context changed.',
  'stock.itemExpired':
    'This stock item reference expired or the active context changed.',
  'stock.unauthorized': 'This chat is not authorized to view inventory.',
  'stock.thresholdUnset':
    'WCTM quantitative low-stock threshold is not configured. Explicit WooCommerce out-of-stock items still appear.',
  'stock.threshold': 'WCTM low-stock threshold: {value}',
  'stock.empty': 'No low-stock or out-of-stock items are currently projected.',
  'stock.noLongerAlerting':
    'This inventory item is no longer low or out of stock.',
  'stock.variation': 'Variation: {value}',
  'stock.sku': 'SKU: {value}',
  'stock.quantity': 'Quantity: {value}',
  'stock.wooStatus': 'WooCommerce status: {value}',
  'stock.wctmClass': 'WCTM classification: {value}',
  'stock.wctmThreshold': 'WCTM threshold: {value}',
  'stock.lastSynced': 'Last synchronized: {value}',
  'stock.qtyShort': 'qty {value}',
  'search.title': 'Search',
  'search.usage':
    'Use /search <query> to find projected orders by order number or customer display name, and inventory by SKU or display name.',
  'search.prefix': 'Prefix searches require at least two characters.',
  'search.tooShort':
    'Use at least two characters for a prefix search. A one-character exact order number or SKU is still accepted.',
  'search.unauthorized':
    'This chat is not authorized to search store projections.',
  'search.expired':
    'This search expired or the active context changed. Start a new search.',
  'search.results': 'Search Results',
  'search.empty': 'No matching projected orders or inventory items.',
  'search.partial':
    'Inventory is not READY; these results include Orders only and are therefore partial.',
  'search.resultUnauthorized':
    'This chat is not authorized to open this search result.',
  'search.inventorySyncing':
    'Inventory is not READY. Start a new search after synchronization completes.',
  'search.resultExpired':
    'This search result expired, changed context, or is no longer available.',
  'report.title': 'Daily Operational Report',
  'report.unauthorized':
    'This chat is not authorized to view the daily report.',
  'report.unavailable': 'The daily report is unavailable.',
  'report.ordersToday': 'Orders created today: {value}',
  'report.grossNone': 'Gross operational sales: none',
  'report.gross': 'Gross sales ({currency}): {value}',
  'report.aov': 'Average order value ({currency}): {value}',
  'report.omitted':
    'Revenue-eligible orders omitted for invalid total/currency: {value}',
  'report.statusNone': 'Status distribution: none',
  'report.statuses': 'Status distribution:',
  'report.low': 'Current low stock: {value}',
  'report.out': 'Current out of stock: {value}',
  'report.inventoryUnavailable': 'Inventory counts unavailable ({value}).',
  'report.delayed': 'Order projection data may be delayed.',
  'report.disclaimer':
    'Projected operational summary; not accounting or net revenue.',
  'orders.title': 'Recent Orders',
  'orders.empty': 'No recent orders are available yet.',
  'orders.emptyHint': 'New orders will appear here after they are received.',
  'orders.order': 'Order #{number}',
  'orders.status': 'Status: {value}',
  'orders.customer': 'Customer: {value}',
  'orders.total': 'Total: {value}',
  'orders.created': 'Created: {value}',
  'orders.modified': 'Modified: {value}',
  'orders.items': 'Items',
  'orders.payment': 'Payment: {method} • {state}',
  'orders.shipping': 'Shipping: {value}',
  'orders.shipTo': 'Ship to: {value}',
  'orders.deletedWoo': 'This order was deleted in WooCommerce.',
  'orders.notFound':
    'This order is no longer available. Return to Recent Orders to continue.',
  'orders.lookupUsage':
    'Use /order <number> with one exact order number, for example /order 1001.',
  'orders.ambiguous':
    'A single exact order could not be identified. No order was opened.',
  'orders.refreshed': 'Order refreshed from WooCommerce.',
  'orders.refreshRetryable':
    'WooCommerce could not be reached to refresh this order. No repeated refresh was started.',
  'orders.refreshFailed':
    'WooCommerce returned an invalid refresh result. The existing order projection was not replaced.',
  'orders.lastUpdated': 'Last updated {value}',
  'orders.delayed': 'delayed',
  'notes.title': 'Add Order Note',
  'notes.internalHelp': 'Internal notes are visible to store staff only.',
  'notes.customerHelp':
    'Customer-visible notes use WooCommerce customer-note delivery behavior.',
  'notes.choose': 'Choose visibility:',
  'notes.visibility': 'Visibility: {value}',
  'notes.replyReview':
    'Reply to the prompt with plain text. You will review it before anything is sent to WooCommerce.',
  'notes.prompt':
    'Reply to this message with the plain-text note (maximum {value} characters).',
  'notes.placeholder': 'Enter order note',
  'notes.reference': 'Note reference:',
  'notes.confirmTitle': 'Confirm Order Note',
  'notes.preview': 'Preview: {value}',
  'notes.confirmHelp':
    'Confirming creates one WooCommerce note. This action cannot be edited or deleted here.',
  'notes.invalidDetailed':
    'The note must be non-empty plain text, at most 1,000 characters, without HTML markup or control characters. No note was created.',
  'notes.success':
    'The {visibility} note was created once in WooCommerce{order}.',
  'notes.forOrder': ' for order #{number}',
  'notes.cancelled':
    'Note creation was cancelled. Nothing was sent to WooCommerce.',
  'notes.forbidden':
    'Your membership can view orders but cannot create order notes.',
  'notes.expired': 'This note action expired. No note was created.',
  'notes.invalid': 'The note text is invalid. No note was created.',
  'notes.inProgress':
    'This note action is already being processed. It was not dispatched again.',
  'notes.ambiguous':
    'WooCommerce may have received this note, but the result could not be confirmed. It will not be sent again automatically.',
  'notes.retryable':
    'WooCommerce safely rejected or deferred this note request. It was not sent again; start a new note action if needed.',
  'notes.deleted':
    'This order was deleted in WooCommerce. No note was created.',
  'notes.notFound': 'This order is no longer available. No note was created.',
  'notes.failed': 'WooCommerce did not create the note. It was not sent again.',
  'statusChange.title': 'Change Status',
  'statusChange.current': 'Current status: {value}',
  'statusChange.choose': 'Choose the new status:',
  'statusChange.none':
    'No supported status changes are available from {value}.',
  'statusChange.forbidden':
    'Your membership can view orders but cannot change their status.',
  'statusChange.expired':
    'This status action expired. No change was made. Refresh Recent Orders and open the order again.',
  'statusChange.invalid':
    'That status is no longer available for this order. No change was made.',
  'statusChange.retryable':
    'WooCommerce could not confirm the change. Refresh Recent Orders and verify the current status before trying again.',
  'statusChange.failed':
    'WooCommerce did not accept the status change. Refresh Recent Orders to continue.',
  'statusChange.notFound': 'This order is no longer available.',
  'statusChange.noneAvailable': 'No status change is available.',
  'statusChange.success': 'Status updated successfully.',
  'statusChange.noOp': 'The order already has that status.',
  'notification.newOrder': 'New Order',
  'notification.lowStock': 'Low Stock',
  'notification.outOfStock': 'Out of Stock',
  'label.fa': 'Persian',
  'label.en': 'English',
  'label.orderCreated': 'New order',
  'label.lowStockCategory': 'Low stock',
  'label.allEligible': 'All eligible managers',
  'label.selected': 'Selected managers',
  'label.available': 'Available',
  'label.unavailable': 'Unavailable',
  'label.owner': 'Owner',
  'label.admin': 'Admin',
  'label.member': 'Member',
  'label.paid': 'Paid',
  'label.unpaid': 'Unpaid',
  'label.internal': 'Internal',
  'label.customer': 'Customer-visible',
  'label.healthy': 'Healthy',
  'label.lowStock': 'Low stock',
  'label.outOfStock': 'Out of stock',
  'label.entitlementActive': 'Active',
  'label.entitlementSuspended': 'Suspended',
  'label.entitlementExpired': 'Expired',
  'label.planFree': 'Free',
  'label.planPro': 'Pro',
  'label.planAgency': 'Agency',
  'label.pending': 'Pending payment',
  'label.processing': 'Processing',
  'label.onHold': 'On hold',
  'label.completed': 'Completed',
  'label.cancelled': 'Cancelled',
  'label.refunded': 'Refunded',
  'label.failed': 'Failed',
  'label.unknownStatus': 'Custom status ({value})',
  'label.currentStatus': 'the current status',
  'command.start': 'Open Home or link your account',
  'command.orders': 'Open recent orders',
  'command.order': 'Open an exact order number',
  'command.status': 'Check account and store access',
  'command.settings': 'View or manage store settings',
  'command.stock': 'Show low and out-of-stock items',
  'command.search': 'Search orders and inventory',
  'command.report': 'Show today’s operational report',
  'command.help': 'Show available commands',
  'command.unlink': 'Unlink this Telegram account',
  'fallback.missing': 'Something went wrong. Return Home and try again.',
} as const;

export type MessageKey = keyof typeof en;

const fa: Record<MessageKey, string> = {
  'general.privateOnly':
    'این ربات فقط در گفت‌وگوی خصوصی تلگرام قابل استفاده است.',
  'general.transientFailure':
    'سرویس موقتاً در دسترس نیست. به خانه برگردید یا کمی بعد دوباره تلاش کنید.',
  'general.invalidToken':
    'توکن اتصال نامعتبر یا منقضی است. یک توکن تازه بگیرید و دوباره تلاش کنید.',
  'general.expiredList':
    'این صفحه منقضی شده یا زمینهٔ فعال تغییر کرده است. صفحه را تازه کنید و دوباره تلاش کنید.',
  'general.unauthorizedOrders':
    'این گفت‌وگو اجازهٔ مشاهدهٔ سفارش‌ها را ندارد. برای راهنمای بازیابی، وضعیت را بررسی کنید.',
  'general.noActiveStore':
    'برای این گفت‌وگو یک فروشگاه فعال یکتا در دسترس نیست. ابتدا وضعیت را بررسی کنید.',
  'entitlement.requiredSuspended':
    'دسترسی سرویس تعلیق شده است. قابلیت‌های عملیاتی در دسترس نیستند؛ وضعیت، راهنما، تنظیمات و قطع اتصال همچنان در دسترس‌اند.',
  'entitlement.requiredExpired':
    'دسترسی سرویس منقضی شده است. قابلیت‌های عملیاتی در دسترس نیستند؛ وضعیت، راهنما، تنظیمات و قطع اتصال همچنان در دسترس‌اند.',
  'entitlement.plan': 'طرح: {value}',
  'entitlement.access': 'دسترسی سرویس: {value}',
  'entitlement.expiry': 'پایان دسترسی: {value}',
  'entitlement.noExpiry': 'بدون تاریخ انقضا',
  'entitlement.settingsInactive':
    'تا زمانی که دسترسی سرویس غیرفعال است، تنظیمات فقط خواندنی هستند.',
  'general.malformedResponse':
    'پاسخ سرویس غیرمنتظره بود. به خانه برگردید یا کمی بعد دوباره تلاش کنید.',
  'general.unavailable': 'در دسترس نیست',
  'general.none': 'هیچ‌کدام',
  'general.notConfigured': 'تنظیم نشده',
  'general.notManaged': 'مدیریت نمی‌شود',
  'general.notSpecified': 'مشخص نشده',
  'general.deleted': 'حذف‌شده',
  'general.yes': 'بله',
  'general.no': 'خیر',
  'home.title': 'مدیریت ووکامرس',
  'home.choose': 'یک گزینه را انتخاب کنید.',
  'home.linked': 'حساب با موفقیت متصل شد.',
  'status.title': 'وضعیت حساب',
  'status.unlinked':
    'این حساب تلگرام متصل نیست. برای اتصال از \u2068/start <token>\u2069 استفاده کنید.',
  'status.noMembership': 'حساب تلگرام متصل است، اما عضویت فعال در دسترس نیست.',
  'status.selectionRequired':
    'حساب تلگرام متصل است. انتخاب مستأجر یا فروشگاه در مرحلهٔ بعدی راه‌اندازی لازم است.',
  'status.ready': 'حساب تلگرام متصل و مجاز است.',
  'status.noStore':
    'حساب تلگرام متصل است، اما زمینهٔ فروشگاه فعال در دسترس نیست.',
  'help.title': 'راهنما',
  'help.body':
    '\u2068/start\u2069 — خانه یا اتصال با توکن\n\u2068/orders\u2069 — سفارش‌های اخیر\n\u2068/order <number>\u2069 — بازکردن شماره سفارش دقیق\n\u2068/stock\u2069 — اقلام کم‌موجود و ناموجود\n\u2068/search <query>\u2069 — جست‌وجوی سفارش و موجودی\n\u2068/report\u2069 — گزارش عملیاتی امروز\n\u2068/status\u2069 — وضعیت حساب و فروشگاه\n\u2068/settings\u2069 — مشاهده یا مدیریت تنظیمات\n\u2068/help\u2069 — فهرست فرمان‌ها\n\u2068/unlink\u2069 — قطع اتصال حساب تلگرام',
  'help.secureActions':
    'جزئیات، تازه‌سازی، تغییر وضعیت و یادداشت‌های مجاز با دکمه‌های امن ربات انجام می‌شوند.',
  'unlink.confirm':
    'اتصال این حساب تلگرام قطع شود؟ برای اتصال دوباره به توکن تازه نیاز دارید.',
  'unlink.success': 'اتصال حساب تلگرام قطع شد.',
  'unlink.unauthorized': 'این گفت‌وگو مجاز نیست.',
  'nav.home': 'خانه',
  'nav.orders': 'سفارش‌های اخیر',
  'nav.refreshOrders': 'تازه‌سازی سفارش‌ها',
  'nav.status': 'وضعیت',
  'nav.checkStatus': 'بررسی وضعیت',
  'nav.help': 'راهنما',
  'nav.settings': 'تنظیمات',
  'nav.backSettings': 'بازگشت به تنظیمات',
  'nav.stock': 'موجودی',
  'nav.refreshStock': 'تازه‌سازی موجودی',
  'nav.search': 'جست‌وجو',
  'nav.newSearch': 'جست‌وجوی تازه',
  'nav.report': 'گزارش روزانه',
  'nav.previous': 'قبلی',
  'nav.next': 'بعدی',
  'nav.backOrder': 'بازگشت به سفارش',
  'nav.backOrders': 'بازگشت به سفارش‌ها',
  'nav.backStock': 'بازگشت به موجودی',
  'nav.backSearch': 'بازگشت به جست‌وجو',
  'action.confirm': 'تأیید',
  'action.cancel': 'لغو',
  'action.confirmUnlink': 'تأیید قطع اتصال',
  'action.changeStatus': 'تغییر وضعیت',
  'action.refresh': 'تازه‌سازی',
  'action.addNote': 'افزودن یادداشت',
  'action.viewOrder': 'مشاهده سفارش',
  'action.viewStock': 'مشاهده موجودی',
  'action.setTimezone': 'تنظیم منطقه زمانی',
  'action.setThreshold': 'تنظیم آستانه',
  'action.clearThreshold': 'پاک‌کردن آستانه',
  'action.enable': 'فعال‌کردن {value}',
  'action.disable': 'غیرفعال‌کردن {value}',
  'action.select': 'انتخاب {value}',
  'action.remove': 'حذف {value}',
  'settings.title': 'تنظیمات فروشگاه',
  'settings.language': 'زبان: {value}',
  'settings.timezone': 'منطقه زمانی: {value}',
  'settings.threshold': 'آستانه کم‌موجودی: {value}',
  'settings.notifications': 'اعلان‌ها: {value}',
  'settings.recipients': 'گیرندگان: {value}',
  'settings.selected': 'انتخاب‌شده: {selected} • اکنون در دسترس: {available}',
  'settings.selectedManagers': 'مدیران انتخاب‌شده',
  'settings.unavailableSuffix': ' — در دسترس نیست',
  'settings.readOnly': 'عضویت شما فقط اجازهٔ مشاهدهٔ تنظیمات را دارد.',
  'settings.timezoneReady':
    'ورود منطقه زمانی آماده است. در پیام تازه، منطقه زمانی معتبر IANA را پاسخ دهید.',
  'settings.thresholdReady':
    'ورود آستانه آماده است. در پیام تازه، یک عدد صحیح نامنفی را پاسخ دهید.',
  'settings.timezonePrompt':
    'یک منطقه زمانی معتبر IANA پاسخ دهید؛ برای نمونه {value}.',
  'settings.thresholdPrompt':
    'آستانه کم‌موجودی را به‌صورت عدد صحیح نامنفی پاسخ دهید.',
  'settings.thresholdPlaceholder': 'آستانه را وارد کنید',
  'settings.reference': 'شناسه تنظیمات:',
  'settings.forbidden':
    'عضویت شما اجازهٔ مشاهده دارد، اما نمی‌تواند تنظیمات را تغییر دهد.',
  'settings.unauthorized':
    'این گفت‌وگو اجازهٔ مشاهدهٔ تنظیمات فروشگاه را ندارد.',
  'settings.invalid':
    'مقدار تنظیم نامعتبر است و چیزی تغییر نکرد. به پیام اصلی پاسخ دهید یا تنظیمات را دوباره باز کنید.',
  'settings.expiredInput':
    'ورودی تنظیمات منقضی شده یا قبلاً استفاده شده است. چیزی تغییر نکرد.',
  'settings.contextChanged':
    'عمل تنظیمات منقضی شده یا زمینهٔ فعال تغییر کرده است. چیزی تغییر نکرد.',
  'settings.unavailable':
    'تنظیمات در دسترس نیست. به خانه برگردید و دوباره تلاش کنید.',
  'stock.title': 'موجودی',
  'stock.syncing':
    'موجودی از کاتالوگ فعلی ووکامرس همگام می‌شود. کمی بعد دوباره تلاش کنید.',
  'stock.syncFailed':
    'همگام‌سازی قبلی کامل نشد. بازیابی در صف است؛ کمی بعد دوباره تلاش کنید.',
  'stock.expired': 'این صفحه موجودی منقضی شده یا زمینهٔ فعال تغییر کرده است.',
  'stock.itemExpired': 'شناسه این قلم منقضی شده یا زمینهٔ فعال تغییر کرده است.',
  'stock.unauthorized': 'این گفت‌وگو اجازهٔ مشاهدهٔ موجودی را ندارد.',
  'stock.thresholdUnset':
    'آستانه عددی کم‌موجودی WCTM تنظیم نشده است. اقلام ناموجود ووکامرس همچنان نمایش داده می‌شوند.',
  'stock.threshold': 'آستانه کم‌موجودی WCTM: {value}',
  'stock.empty': 'اکنون قلم کم‌موجود یا ناموجودی در تصویر داده وجود ندارد.',
  'stock.noLongerAlerting': 'این قلم دیگر کم‌موجود یا ناموجود نیست.',
  'stock.variation': 'تنوع: {value}',
  'stock.sku': 'شناسه کالا: {value}',
  'stock.quantity': 'تعداد: {value}',
  'stock.wooStatus': 'وضعیت ووکامرس: {value}',
  'stock.wctmClass': 'رده‌بندی WCTM: {value}',
  'stock.wctmThreshold': 'آستانه WCTM: {value}',
  'stock.lastSynced': 'آخرین همگام‌سازی: {value}',
  'stock.qtyShort': 'تعداد {value}',
  'search.title': 'جست‌وجو',
  'search.usage':
    'برای یافتن سفارش بر پایه شماره یا نام نمایشی مشتری، و موجودی بر پایه شناسه کالا یا نام، از \u2068/search <query>\u2069 استفاده کنید.',
  'search.prefix': 'جست‌وجوی پیشوندی دست‌کم دو نویسه لازم دارد.',
  'search.tooShort':
    'برای جست‌وجوی پیشوندی دست‌کم دو نویسه وارد کنید. شماره سفارش یا شناسه کالای دقیق یک‌نویسه‌ای پذیرفته می‌شود.',
  'search.unauthorized':
    'این گفت‌وگو اجازهٔ جست‌وجوی داده‌های فروشگاه را ندارد.',
  'search.expired':
    'این جست‌وجو منقضی شده یا زمینهٔ فعال تغییر کرده است. جست‌وجوی تازه‌ای آغاز کنید.',
  'search.results': 'نتایج جست‌وجو',
  'search.empty': 'سفارش یا قلم موجودی منطبقی پیدا نشد.',
  'search.partial':
    'موجودی هنوز آماده نیست؛ این نتایج فقط سفارش‌ها را دربر می‌گیرد و ناقص است.',
  'search.resultUnauthorized': 'این گفت‌وگو اجازهٔ بازکردن این نتیجه را ندارد.',
  'search.inventorySyncing':
    'موجودی هنوز آماده نیست. پس از پایان همگام‌سازی جست‌وجوی تازه‌ای انجام دهید.',
  'search.resultExpired':
    'این نتیجه منقضی شده، زمینه تغییر کرده یا دیگر در دسترس نیست.',
  'report.title': 'گزارش عملیاتی روزانه',
  'report.unauthorized': 'این گفت‌وگو اجازهٔ مشاهدهٔ گزارش روزانه را ندارد.',
  'report.unavailable': 'گزارش روزانه در دسترس نیست.',
  'report.ordersToday': 'سفارش‌های ایجادشده امروز: {value}',
  'report.grossNone': 'فروش ناخالص عملیاتی: ندارد',
  'report.gross': 'فروش ناخالص ({currency}): {value}',
  'report.aov': 'میانگین ارزش سفارش ({currency}): {value}',
  'report.omitted': 'سفارش‌های واجد درآمد با مبلغ یا ارز نامعتبر: {value}',
  'report.statusNone': 'توزیع وضعیت: ندارد',
  'report.statuses': 'توزیع وضعیت:',
  'report.low': 'کم‌موجود فعلی: {value}',
  'report.out': 'ناموجود فعلی: {value}',
  'report.inventoryUnavailable': 'شمارش موجودی در دسترس نیست ({value}).',
  'report.delayed': 'ممکن است داده‌های سفارش با تأخیر به‌روز شده باشند.',
  'report.disclaimer':
    'خلاصه عملیاتی بر پایه داده‌های تصویری؛ نه حسابداری یا درآمد خالص.',
  'orders.title': 'سفارش‌های اخیر',
  'orders.empty': 'هنوز سفارش اخیری در دسترس نیست.',
  'orders.emptyHint':
    'سفارش‌های تازه پس از دریافت در اینجا نمایش داده می‌شوند.',
  'orders.order': 'سفارش شماره {number}',
  'orders.status': 'وضعیت: {value}',
  'orders.customer': 'مشتری: {value}',
  'orders.total': 'مبلغ کل: {value}',
  'orders.created': 'ایجاد: {value}',
  'orders.modified': 'ویرایش: {value}',
  'orders.items': 'اقلام',
  'orders.payment': 'پرداخت: {method} • {state}',
  'orders.shipping': 'ارسال: {value}',
  'orders.shipTo': 'نشانی ارسال: {value}',
  'orders.deletedWoo': 'این سفارش در ووکامرس حذف شده است.',
  'orders.notFound': 'این سفارش دیگر در دسترس نیست. به سفارش‌های اخیر برگردید.',
  'orders.lookupUsage':
    'از \u2068/order <number>\u2069 با یک شماره دقیق استفاده کنید؛ برای نمونه \u2068/order 1001\u2069.',
  'orders.ambiguous': 'یک سفارش دقیق و یکتا شناسایی نشد؛ سفارشی باز نشد.',
  'orders.refreshed': 'سفارش از ووکامرس تازه‌سازی شد.',
  'orders.refreshRetryable':
    'برای تازه‌سازی سفارش دسترسی به ووکامرس ممکن نبود. تازه‌سازی تکراری آغاز نشد.',
  'orders.refreshFailed':
    'نتیجه تازه‌سازی ووکامرس نامعتبر بود. تصویر فعلی سفارش جایگزین نشد.',
  'orders.lastUpdated': 'آخرین به‌روزرسانی {value}',
  'orders.delayed': 'با تأخیر',
  'notes.title': 'افزودن یادداشت سفارش',
  'notes.internalHelp':
    'یادداشت داخلی فقط برای کارکنان فروشگاه قابل مشاهده است.',
  'notes.customerHelp':
    'یادداشت مشتری از رفتار ارسال یادداشت مشتری ووکامرس استفاده می‌کند.',
  'notes.choose': 'نوع نمایش را انتخاب کنید:',
  'notes.visibility': 'نوع نمایش: {value}',
  'notes.replyReview':
    'متن ساده را در پاسخ بنویسید. پیش از ارسال به ووکامرس آن را بازبینی می‌کنید.',
  'notes.prompt':
    'یادداشت متنی را در پاسخ به این پیام بنویسید (حداکثر {value} نویسه).',
  'notes.placeholder': 'یادداشت سفارش',
  'notes.reference': 'شناسه یادداشت:',
  'notes.confirmTitle': 'تأیید یادداشت سفارش',
  'notes.preview': 'پیش‌نمایش: {value}',
  'notes.confirmHelp':
    'با تأیید، یک یادداشت در ووکامرس ساخته می‌شود و از اینجا قابل ویرایش یا حذف نیست.',
  'notes.invalidDetailed':
    'یادداشت باید متن ساده و غیرخالی، حداکثر ۱۰۰۰ نویسه و بدون HTML یا نویسه کنترلی باشد. یادداشتی ساخته نشد.',
  'notes.success': 'یادداشت {visibility} یک‌بار در ووکامرس ساخته شد{order}.',
  'notes.forOrder': ' برای سفارش شماره {number}',
  'notes.cancelled': 'ساخت یادداشت لغو شد و چیزی به ووکامرس ارسال نشد.',
  'notes.forbidden':
    'عضویت شما اجازهٔ مشاهده سفارش را دارد، اما نمی‌تواند یادداشت بسازد.',
  'notes.expired': 'عمل یادداشت منقضی شده و یادداشتی ساخته نشد.',
  'notes.invalid': 'متن یادداشت نامعتبر است و یادداشتی ساخته نشد.',
  'notes.inProgress': 'این عمل یادداشت در حال پردازش است و دوباره ارسال نشد.',
  'notes.ambiguous':
    'ممکن است ووکامرس یادداشت را دریافت کرده باشد، اما نتیجه تأیید نشد. ارسال خودکار تکرار نمی‌شود.',
  'notes.retryable':
    'ووکامرس درخواست یادداشت را با نتیجه امن رد یا عقب انداخت. ارسال تکرار نشد؛ در صورت نیاز عمل تازه‌ای آغاز کنید.',
  'notes.deleted': 'این سفارش در ووکامرس حذف شده و یادداشتی ساخته نشد.',
  'notes.notFound': 'این سفارش دیگر در دسترس نیست و یادداشتی ساخته نشد.',
  'notes.failed': 'ووکامرس یادداشت را نساخت و ارسال تکرار نشد.',
  'statusChange.title': 'تغییر وضعیت',
  'statusChange.current': 'وضعیت فعلی: {value}',
  'statusChange.choose': 'وضعیت تازه را انتخاب کنید:',
  'statusChange.none': 'از وضعیت {value} تغییر پشتیبانی‌شده‌ای وجود ندارد.',
  'statusChange.forbidden':
    'عضویت شما اجازهٔ مشاهده سفارش را دارد، اما نمی‌تواند وضعیت را تغییر دهد.',
  'statusChange.expired':
    'عمل تغییر وضعیت منقضی شد و تغییری انجام نشد. سفارش‌های اخیر را تازه کنید.',
  'statusChange.invalid':
    'این وضعیت دیگر برای سفارش مجاز نیست و تغییری انجام نشد.',
  'statusChange.retryable':
    'ووکامرس تغییر را تأیید نکرد. سفارش‌های اخیر را تازه کنید و پیش از تلاش دوباره وضعیت را بررسی کنید.',
  'statusChange.failed':
    'ووکامرس تغییر وضعیت را نپذیرفت. سفارش‌های اخیر را تازه کنید.',
  'statusChange.notFound': 'این سفارش دیگر در دسترس نیست.',
  'statusChange.noneAvailable': 'تغییر وضعیتی در دسترس نیست.',
  'statusChange.success': 'وضعیت با موفقیت تغییر کرد.',
  'statusChange.noOp': 'سفارش از قبل همین وضعیت را دارد.',
  'notification.newOrder': 'سفارش تازه',
  'notification.lowStock': 'هشدار کم‌موجودی',
  'notification.outOfStock': 'هشدار ناموجودی',
  'label.fa': 'فارسی',
  'label.en': 'انگلیسی',
  'label.orderCreated': 'سفارش تازه',
  'label.lowStockCategory': 'کم‌موجودی',
  'label.allEligible': 'همه مدیران واجد شرایط',
  'label.selected': 'مدیران انتخاب‌شده',
  'label.available': 'در دسترس',
  'label.unavailable': 'در دسترس نیست',
  'label.owner': 'مالک',
  'label.admin': 'مدیر',
  'label.member': 'عضو',
  'label.paid': 'پرداخت‌شده',
  'label.unpaid': 'پرداخت‌نشده',
  'label.internal': 'داخلی',
  'label.customer': 'قابل مشاهده برای مشتری',
  'label.healthy': 'سالم',
  'label.lowStock': 'کم‌موجود',
  'label.outOfStock': 'ناموجود',
  'label.entitlementActive': 'فعال',
  'label.entitlementSuspended': 'تعلیق‌شده',
  'label.entitlementExpired': 'منقضی',
  'label.planFree': 'رایگان',
  'label.planPro': 'حرفه‌ای',
  'label.planAgency': 'آژانسی',
  'label.pending': 'در انتظار پرداخت',
  'label.processing': 'در حال انجام',
  'label.onHold': 'در انتظار بررسی',
  'label.completed': 'تکمیل‌شده',
  'label.cancelled': 'لغوشده',
  'label.refunded': 'بازپرداخت‌شده',
  'label.failed': 'ناموفق',
  'label.unknownStatus': 'وضعیت سفارشی ({value})',
  'label.currentStatus': 'وضعیت فعلی',
  'command.start': 'خانه یا اتصال حساب',
  'command.orders': 'سفارش‌های اخیر',
  'command.order': 'بازکردن شماره سفارش دقیق',
  'command.status': 'وضعیت حساب و فروشگاه',
  'command.settings': 'تنظیمات فروشگاه',
  'command.stock': 'اقلام کم‌موجود و ناموجود',
  'command.search': 'جست‌وجوی سفارش و موجودی',
  'command.report': 'گزارش عملیاتی امروز',
  'command.help': 'فرمان‌های در دسترس',
  'command.unlink': 'قطع اتصال حساب تلگرام',
  'fallback.missing': 'خطایی رخ داد. به خانه برگردید و دوباره تلاش کنید.',
};

export const catalogs = { en, fa } as const;

export function resolveLanguage(value: unknown): TelegramLanguage {
  return value === 'fa' ? 'fa' : 'en';
}

export function languageOf(
  value: { presentation?: Partial<PresentationMetadata> } | undefined,
  fallback: TelegramLanguage = 'en'
): TelegramLanguage {
  if (!value?.presentation || value.presentation.language === undefined) {
    return fallback;
  }

  return resolveLanguage(value.presentation.language);
}

export function timezoneOf(
  value: { presentation?: Partial<PresentationMetadata> } | undefined
): string {
  const timezone = value?.presentation?.timezone;

  if (typeof timezone !== 'string') {
    return 'UTC';
  }

  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch {
    return 'UTC';
  }
}

export function translate(
  language: TelegramLanguage,
  key: MessageKey,
  values: InterpolationValues = {},
  diagnostic?: Diagnostic
): string {
  return translateFromCatalogs(
    language,
    key,
    values,
    catalogs,
    diagnostic ?? defaultDiagnostic
  );
}

export function translateFromCatalogs(
  language: TelegramLanguage,
  key: string,
  values: InterpolationValues,
  source: Readonly<Record<TelegramLanguage, Readonly<Record<string, string>>>>,
  diagnostic?: Diagnostic
): string {
  const preferred = source[language]?.[key];
  const english = source.en?.[key];
  const template = preferred ?? english;

  if (!preferred && language === 'fa') {
    diagnostic?.(`missing-fa:${safeDiagnosticKey(key)}`);
  }

  if (!template) {
    diagnostic?.(`missing-all:${safeDiagnosticKey(key)}`);
    return en['fallback.missing'];
  }

  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name) =>
    safeInterpolation(values[name] ?? '')
  );
}

export function isolateLtr(value: string | number): string {
  return `\u2068${safeInterpolation(value)}\u2069`;
}

export function formatNumber(
  value: string | number,
  language: TelegramLanguage
): string {
  const numeric = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(numeric)) {
    return safeInterpolation(value);
  }

  return new Intl.NumberFormat(language === 'fa' ? 'fa-IR' : 'en-US', {
    maximumFractionDigits: 20,
    useGrouping: true,
  }).format(numeric);
}

export function formatMoney(
  amount: string,
  currency: string,
  language: TelegramLanguage
): string {
  const numeric = Number(amount);
  const rawCode = safeInterpolation(currency);
  const code = rawCode.toUpperCase();

  if (
    !Number.isFinite(numeric) ||
    !/^[A-Z]{3}$/.test(code) ||
    !supportedCurrencyCodes().has(code)
  ) {
    return `${formatNumber(amount, language)} ${isolateLtr(rawCode)}`.trim();
  }

  try {
    return new Intl.NumberFormat(language === 'fa' ? 'fa-IR' : 'en-US', {
      style: 'currency',
      currency: code,
      currencyDisplay: 'code',
      maximumFractionDigits: 20,
    }).format(numeric);
  } catch {
    return `${formatNumber(amount, language)} ${isolateLtr(code)}`;
  }
}

export function formatDateTime(
  value: string,
  language: TelegramLanguage,
  timezone: string
): string {
  const date = new Date(value);

  if (Number.isNaN(date.valueOf())) {
    return isolateLtr(value);
  }

  const safeTimezone = validTimezone(timezone) ? timezone : 'UTC';
  const locale =
    language === 'fa' ? 'fa-IR-u-ca-persian' : 'en-GB-u-ca-gregory';

  return new Intl.DateTimeFormat(locale, {
    timeZone: safeTimezone,
    calendar: language === 'fa' ? 'persian' : 'gregory',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(date);
}

export function formatDate(
  value: string,
  language: TelegramLanguage,
  timezone: string
): string {
  const date = new Date(value);

  if (Number.isNaN(date.valueOf())) {
    return isolateLtr(value);
  }

  return new Intl.DateTimeFormat(
    language === 'fa' ? 'fa-IR-u-ca-persian' : 'en-GB-u-ca-gregory',
    {
      timeZone: validTimezone(timezone) ? timezone : 'UTC',
      calendar: language === 'fa' ? 'persian' : 'gregory',
      year: 'numeric',
      month: 'long',
      day: '2-digit',
    }
  ).format(date);
}

export function statusLabel(
  status: string,
  language: TelegramLanguage
): string {
  const keys: Readonly<Record<string, MessageKey>> = {
    pending: 'label.pending',
    processing: 'label.processing',
    'on-hold': 'label.onHold',
    completed: 'label.completed',
    cancelled: 'label.cancelled',
    refunded: 'label.refunded',
    failed: 'label.failed',
  };
  const key = keys[status];

  return key
    ? translate(language, key)
    : translate(language, 'label.unknownStatus', {
        value: isolateLtr(status.slice(0, 64)),
      });
}

export function inventoryLabel(
  value: 'HEALTHY' | 'LOW_STOCK' | 'OUT_OF_STOCK',
  language: TelegramLanguage
): string {
  return translate(
    language,
    value === 'HEALTHY'
      ? 'label.healthy'
      : value === 'LOW_STOCK'
        ? 'label.lowStock'
        : 'label.outOfStock'
  );
}

export function commandMenu(language: TelegramLanguage) {
  const commands = [
    'start',
    'orders',
    'order',
    'status',
    'settings',
    'stock',
    'search',
    'report',
    'help',
    'unlink',
  ] as const;

  return commands.map((command) => ({
    command,
    description: translate(language, `command.${command}`),
  }));
}

function safeInterpolation(value: string | number): string {
  const source = String(value);
  const preserveIsolation =
    source.startsWith('\u2068') && source.endsWith('\u2069');
  const body = preserveIsolation ? source.slice(1, -1) : source;
  const cleaned = Array.from(body)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        ((code >= 32 && code !== 127) ||
          character === '\n' ||
          character === '\t') &&
        !isDirectionalControl(code)
      );
    })
    .join('')
    .slice(0, 512);

  return preserveIsolation ? `\u2068${cleaned}\u2069` : cleaned;
}

function isDirectionalControl(code: number): boolean {
  return (
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
  );
}

function safeDiagnosticKey(key: string): string {
  return /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/.test(key)
    ? key.slice(0, 96)
    : 'invalid-key';
}

function defaultDiagnostic(value: string): void {
  const match = /^(missing-fa|missing-all):(.+)$/.exec(value);
  console.warn(
    JSON.stringify({
      event: 'telegram_localization_fallback',
      code: match?.[1] ?? 'unknown',
      key: safeDiagnosticKey(match?.[2] ?? ''),
    })
  );
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

let currencyCodes: ReadonlySet<string> | undefined;

function supportedCurrencyCodes(): ReadonlySet<string> {
  if (currencyCodes) {
    return currencyCodes;
  }

  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };

  try {
    currencyCodes = new Set(intl.supportedValuesOf?.('currency') ?? []);
  } catch {
    currencyCodes = new Set();
  }

  return currencyCodes;
}
