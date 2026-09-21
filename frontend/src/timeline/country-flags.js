// Country flags for logged airports. The backend attributes an ISO 3166-1
// alpha-2 code to each airport from the bundled OurAirports data; this module
// maps that code to a vendored SVG in frontend/assets/flags (country-flag-icons,
// MIT) and a display name. Flag emoji are not used because Windows renders
// them as letter pairs.

const FLAG_ROOT = '/assets/flags';

// Codes with a vendored SVG. Kept in step with the directory by a test so an
// unknown code (OurAirports uses OC, XP and ZZ as placeholders) renders
// nothing instead of a broken image.
export const COUNTRY_FLAG_CODES = Object.freeze(new Set([
  'AC', 'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD',
  'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC',
  'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK',
  'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'EU', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD',
  'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR',
  'HT', 'HU', 'IC', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH',
  'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA',
  'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX',
  'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH',
  'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE',
  'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ', 'TA', 'TC', 'TD', 'TF',
  'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA',
  'VC', 'VE', 'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'XA', 'XC', 'XK', 'XO', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
]));

export function normalizeCountryCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && COUNTRY_FLAG_CODES.has(code) ? code : '';
}

export function countryFlagSrc(value) {
  const code = normalizeCountryCode(value);
  return code ? `${FLAG_ROOT}/${code}.svg` : '';
}

let displayNames = null;
let displayNamesFailed = false;

export function countryDisplayName(value) {
  const code = normalizeCountryCode(value);
  if (!code) return '';
  if (!displayNames && !displayNamesFailed) {
    try {
      displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      displayNamesFailed = true;
    }
  }
  if (!displayNames) return code;
  try {
    const name = displayNames.of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

const ROUTE_SEPARATOR = ' → ';

/**
 * Split a flight's route label into segments, each carrying the country of the
 * airport it names. Labels are "YSSY → KJFK", "NEAR YSSY → NEAR YMML",
 * "NEAR YSSY" or "Location Unknown"; the first segment is the departure end and
 * the last the arrival end. A single segment takes whichever country is known.
 */
export function flightRouteSegments(flight, label) {
  const text = String(label || '').trim();
  if (!text) return [];
  const parts = text.split(ROUTE_SEPARATOR).map(part => part.trim()).filter(Boolean);
  const departure = normalizeCountryCode(flight?.departureCountry);
  const arrival = normalizeCountryCode(flight?.arrivalCountry);
  if (parts.length === 1) return [{ text: parts[0], country: departure || arrival }];
  return parts.map((part, index) => ({
    text: part,
    country: index === 0 ? departure : index === parts.length - 1 ? arrival : '',
  }));
}
