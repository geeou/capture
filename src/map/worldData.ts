// Hand-written geographic data for the world map: Italian country names, mountain ranges,
// big lakes and the straits that must stay navigable. Coordinates are [lon, lat] degrees.

/** Natural Earth (world-atlas countries-50m) name → Italian. */
export const ITALIAN_NAMES: Record<string, string> = {
  'Afghanistan': 'Afghanistan', 'Albania': 'Albania', 'Algeria': 'Algeria', 'American Samoa': 'Samoa Americane',
  'Andorra': 'Andorra', 'Angola': 'Angola', 'Anguilla': 'Anguilla', 'Antarctica': 'Antartide',
  'Antigua and Barb.': 'Antigua e Barbuda', 'Argentina': 'Argentina', 'Armenia': 'Armenia', 'Aruba': 'Aruba',
  'Ashmore and Cartier Is.': 'Isole Ashmore e Cartier', 'Australia': 'Australia', 'Austria': 'Austria',
  'Azerbaijan': 'Azerbaigian', 'Bahamas': 'Bahamas', 'Bahrain': 'Bahrein', 'Bangladesh': 'Bangladesh',
  'Barbados': 'Barbados', 'Belarus': 'Bielorussia', 'Belgium': 'Belgio', 'Belize': 'Belize', 'Benin': 'Benin',
  'Bermuda': 'Bermuda', 'Bhutan': 'Bhutan', 'Bolivia': 'Bolivia', 'Bosnia and Herz.': 'Bosnia ed Erzegovina',
  'Botswana': 'Botswana', 'Br. Indian Ocean Ter.': "Territorio britannico dell'Oceano Indiano", 'Brazil': 'Brasile',
  'British Virgin Is.': 'Isole Vergini britanniche', 'Brunei': 'Brunei', 'Bulgaria': 'Bulgaria',
  'Burkina Faso': 'Burkina Faso', 'Burundi': 'Burundi', 'Cabo Verde': 'Capo Verde', 'Cambodia': 'Cambogia',
  'Cameroon': 'Camerun', 'Canada': 'Canada', 'Cayman Is.': 'Isole Cayman', 'Central African Rep.': 'Repubblica Centrafricana',
  'Chad': 'Ciad', 'Chile': 'Cile', 'China': 'Cina', 'Colombia': 'Colombia', 'Comoros': 'Comore', 'Congo': 'Congo',
  'Cook Is.': 'Isole Cook', 'Costa Rica': 'Costa Rica', "Côte d'Ivoire": "Costa d'Avorio", 'Croatia': 'Croazia',
  'Cuba': 'Cuba', 'Curaçao': 'Curaçao', 'Cyprus': 'Cipro', 'Czechia': 'Cechia', 'Dem. Rep. Congo': 'Rep. Dem. del Congo',
  'Denmark': 'Danimarca', 'Djibouti': 'Gibuti', 'Dominica': 'Dominica', 'Dominican Rep.': 'Repubblica Dominicana',
  'Ecuador': 'Ecuador', 'Egypt': 'Egitto', 'El Salvador': 'El Salvador', 'Eq. Guinea': 'Guinea Equatoriale',
  'Eritrea': 'Eritrea', 'Estonia': 'Estonia', 'eSwatini': 'Eswatini', 'Ethiopia': 'Etiopia', 'Faeroe Is.': 'Isole Fær Øer',
  'Falkland Is.': 'Isole Falkland', 'Fiji': 'Figi', 'Finland': 'Finlandia', 'Fr. Polynesia': 'Polinesia francese',
  'Fr. S. Antarctic Lands': 'Terre australi francesi', 'France': 'Francia', 'Gabon': 'Gabon', 'Gambia': 'Gambia',
  'Georgia': 'Georgia', 'Germany': 'Germania', 'Ghana': 'Ghana', 'Greece': 'Grecia', 'Greenland': 'Groenlandia',
  'Grenada': 'Grenada', 'Guam': 'Guam', 'Guatemala': 'Guatemala', 'Guernsey': 'Guernsey', 'Guinea': 'Guinea',
  'Guinea-Bissau': 'Guinea-Bissau', 'Guyana': 'Guyana', 'Haiti': 'Haiti',
  'Heard I. and McDonald Is.': 'Isole Heard e McDonald', 'Honduras': 'Honduras', 'Hong Kong': 'Hong Kong',
  'Hungary': 'Ungheria', 'Iceland': 'Islanda', 'India': 'India', 'Indian Ocean Ter.': "Territori australiani dell'Oceano Indiano",
  'Indonesia': 'Indonesia', 'Iran': 'Iran', 'Iraq': 'Iraq', 'Ireland': 'Irlanda', 'Isle of Man': 'Isola di Man',
  'Israel': 'Israele', 'Italy': 'Italia', 'Jamaica': 'Giamaica', 'Japan': 'Giappone', 'Jersey': 'Jersey',
  'Jordan': 'Giordania', 'Kazakhstan': 'Kazakistan', 'Kenya': 'Kenya', 'Kiribati': 'Kiribati', 'Kosovo': 'Kosovo',
  'Kuwait': 'Kuwait', 'Kyrgyzstan': 'Kirghizistan', 'Laos': 'Laos', 'Latvia': 'Lettonia', 'Lebanon': 'Libano',
  'Lesotho': 'Lesotho', 'Liberia': 'Liberia', 'Libya': 'Libia', 'Liechtenstein': 'Liechtenstein', 'Lithuania': 'Lituania',
  'Luxembourg': 'Lussemburgo', 'Macao': 'Macao', 'Macedonia': 'Macedonia del Nord', 'Madagascar': 'Madagascar',
  'Malawi': 'Malawi', 'Malaysia': 'Malaysia', 'Maldives': 'Maldive', 'Mali': 'Mali', 'Malta': 'Malta',
  'Marshall Is.': 'Isole Marshall', 'Mauritania': 'Mauritania', 'Mauritius': 'Mauritius', 'Mexico': 'Messico',
  'Micronesia': 'Micronesia', 'Moldova': 'Moldavia', 'Monaco': 'Monaco', 'Mongolia': 'Mongolia', 'Montenegro': 'Montenegro',
  'Montserrat': 'Montserrat', 'Morocco': 'Marocco', 'Mozambique': 'Mozambico', 'Myanmar': 'Birmania',
  'N. Cyprus': 'Cipro del Nord', 'N. Mariana Is.': 'Isole Marianne Settentrionali', 'Namibia': 'Namibia', 'Nauru': 'Nauru',
  'Nepal': 'Nepal', 'Netherlands': 'Paesi Bassi', 'New Caledonia': 'Nuova Caledonia', 'New Zealand': 'Nuova Zelanda',
  'Nicaragua': 'Nicaragua', 'Niger': 'Niger', 'Nigeria': 'Nigeria', 'Niue': 'Niue', 'Norfolk Island': 'Isola Norfolk',
  'North Korea': 'Corea del Nord', 'Norway': 'Norvegia', 'Oman': 'Oman', 'Pakistan': 'Pakistan', 'Palau': 'Palau',
  'Palestine': 'Palestina', 'Panama': 'Panamá', 'Papua New Guinea': 'Papua Nuova Guinea', 'Paraguay': 'Paraguay',
  'Peru': 'Perù', 'Philippines': 'Filippine', 'Pitcairn Is.': 'Isole Pitcairn', 'Poland': 'Polonia', 'Portugal': 'Portogallo',
  'Puerto Rico': 'Porto Rico', 'Qatar': 'Qatar', 'Romania': 'Romania', 'Russia': 'Russia', 'Rwanda': 'Ruanda',
  'S. Geo. and the Is.': 'Georgia del Sud', 'S. Sudan': 'Sudan del Sud', 'Saint Helena': "Sant'Elena",
  'Saint Lucia': 'Santa Lucia', 'Samoa': 'Samoa', 'San Marino': 'San Marino', 'São Tomé and Principe': 'São Tomé e Príncipe',
  'Saudi Arabia': 'Arabia Saudita', 'Senegal': 'Senegal', 'Serbia': 'Serbia', 'Seychelles': 'Seychelles',
  'Siachen Glacier': 'Ghiacciaio Siachen', 'Sierra Leone': 'Sierra Leone', 'Singapore': 'Singapore',
  'Sint Maarten': 'Sint Maarten', 'Slovakia': 'Slovacchia', 'Slovenia': 'Slovenia', 'Solomon Is.': 'Isole Salomone',
  'Somalia': 'Somalia', 'Somaliland': 'Somaliland', 'South Africa': 'Sudafrica', 'South Korea': 'Corea del Sud',
  'Spain': 'Spagna', 'Sri Lanka': 'Sri Lanka', 'St-Barthélemy': 'Saint-Barthélemy', 'St-Martin': 'Saint-Martin',
  'St. Kitts and Nevis': 'Saint Kitts e Nevis', 'St. Pierre and Miquelon': 'Saint-Pierre e Miquelon',
  'St. Vin. and Gren.': 'Saint Vincent e Grenadine', 'Sudan': 'Sudan', 'Suriname': 'Suriname', 'Sweden': 'Svezia',
  'Switzerland': 'Svizzera', 'Syria': 'Siria', 'Taiwan': 'Taiwan', 'Tajikistan': 'Tagikistan', 'Tanzania': 'Tanzania',
  'Thailand': 'Thailandia', 'Timor-Leste': 'Timor Est', 'Togo': 'Togo', 'Tonga': 'Tonga',
  'Trinidad and Tobago': 'Trinidad e Tobago', 'Tunisia': 'Tunisia', 'Turkey': 'Turchia', 'Turkmenistan': 'Turkmenistan',
  'Turks and Caicos Is.': 'Turks e Caicos', 'U.S. Virgin Is.': 'Isole Vergini americane', 'Uganda': 'Uganda',
  'Ukraine': 'Ucraina', 'United Arab Emirates': 'Emirati Arabi Uniti', 'United Kingdom': 'Regno Unito',
  'United States of America': 'Stati Uniti', 'Uruguay': 'Uruguay', 'Uzbekistan': 'Uzbekistan', 'Vanuatu': 'Vanuatu',
  'Vatican': 'Città del Vaticano', 'Venezuela': 'Venezuela', 'Vietnam': 'Vietnam', 'W. Sahara': 'Sahara Occidentale',
  'Wallis and Futuna Is.': 'Wallis e Futuna', 'Yemen': 'Yemen', 'Zambia': 'Zambia', 'Zimbabwe': 'Zimbabwe',
  'Åland': 'Isole Åland',
};

/** A ridge: polyline, half-width in degrees (latitude-equivalent), peak height 0..1. */
export interface Range { pts: [number, number][]; w: number; h: number }

const R = (w: number, h: number, ...pts: [number, number][]): Range => ({ pts, w, h });

export const RANGES: Range[] = [
  // ── Europe
  R(1.2, 1.0, [5.8, 44.2], [7, 45.9], [8.5, 46.4], [10.5, 46.6], [13, 47.1], [15.5, 47.5]), // Alps
  R(0.7, 0.9, [-1.8, 43.1], [0.5, 42.7], [3, 42.5]), // Pyrenees
  R(0.6, 0.6, [-8, 43], [-4, 43.1]), // Cantabrian
  R(0.8, 0.5, [-6.8, 40.3], [-3.5, 40.8]), // Sistema Central
  R(0.6, 0.55, [-4.5, 37], [-2.5, 37.2]), // Sierra Nevada (ES)
  R(0.7, 0.6, [8.5, 44.4], [11, 44], [13, 42.5], [15.5, 40.5], [16.2, 39]), // Apennines
  R(1.0, 0.7, [14.5, 45.5], [17, 44], [19.5, 42.5], [20.5, 41], [21.5, 39.5]), // Dinaric / Pindus
  R(1.0, 0.8, [17.5, 48.8], [20, 49.3], [23, 48.8], [25, 47.8], [26, 46], [25, 45.5], [22.5, 45.4]), // Carpathians
  R(0.6, 0.6, [22.5, 43.5], [26.5, 42.8]), // Balkan mts
  R(0.6, 0.5, [23, 41.8], [25, 41.6]), // Rhodopes
  R(0.9, 0.45, [2.5, 45.5], [3.5, 44.8]), // Massif Central
  R(0.6, 0.45, [12.5, 50.4], [16.5, 50.4]), // Ore / Sudetes
  R(1.0, 0.5, [-6, 57], [-3.5, 57.5]), // Scottish Highlands
  R(1.8, 0.85, [6, 58.8], [8, 61.5], [12, 63.5], [15, 66.5], [18, 68.5], [22, 70]), // Scandinavian
  R(1.2, 0.5, [-21, 64.6], [-15, 65]), // Iceland
  R(1.3, 0.65, [59, 51.5], [59, 55], [59.5, 60], [60, 64], [63, 67], [66, 68.5]), // Urals
  // ── Caucasus, Anatolia, Iran, Central Asia
  R(1.0, 1.0, [37.5, 44.5], [42, 43.2], [46, 41.8], [49.5, 40.5]), // Caucasus
  R(1.2, 0.85, [29, 37], [33, 36.8], [36, 37.5], [40, 38.5], [43, 39], [44.5, 39.5]), // Taurus / E. Anatolia
  R(0.8, 0.7, [31, 41], [37, 40.7], [41.5, 40.8]), // Pontic
  R(1.6, 0.9, [44.5, 38], [46, 35], [48.5, 32.5], [51, 30], [54, 28], [57, 27.5]), // Zagros
  R(1.0, 0.8, [46, 38.5], [49, 37], [52, 36], [56, 37.5], [59, 37]), // Alborz / Kopet Dag
  R(1.2, 0.6, [69.5, 32], [68, 28]), // Sulaiman
  R(1.5, 1.0, [62, 34.5], [66, 35], [69, 35.5], [71.5, 36.5]), // Hindu Kush
  R(1.6, 0.95, [70, 38.5], [74, 39.5], [78, 41.5], [82, 42.5], [86, 43], [90, 43.5], [94, 43]), // Pamir / Tian Shan
  R(1.5, 0.8, [85, 50], [89, 49], [93, 48], [97, 46]), // Altai
  R(1.3, 0.7, [90, 52], [96, 52], [102, 51.5]), // Sayan
  R(1.5, 0.6, [96, 48], [100, 47.5], [103, 47]), // Khangai
  // ── Himalaya / Tibet / China
  R(1.5, 1.0, [73, 35], [76, 33.5], [80, 30.5], [84, 28.5], [88, 27.8], [92, 28], [95, 28.8]), // Himalaya
  R(1.5, 1.0, [75, 36], [80, 36], [86, 36], [92, 35.8], [98, 35]), // Karakoram / Kunlun
  R(3.2, 0.82, [80, 32.5], [86, 32], [92, 32], [97, 31.5]), // Tibetan plateau
  R(1.5, 0.85, [98, 33], [99, 29], [100, 25]), // Hengduan
  R(1.2, 0.6, [101, 37.5], [104, 36]), // Qilian
  R(1.2, 0.6, [104, 34], [108, 33.8], [111, 33.5]), // Qinling
  R(2.2, 0.45, [102, 26], [106, 26]), // Yunnan-Guizhou
  R(1.4, 0.45, [120, 43], [121, 48], [122, 52]), // Greater Khingan
  R(1.3, 0.5, [134, 44], [137, 47], [139, 50]), // Sikhote-Alin
  R(0.6, 0.7, [120.9, 22.5], [121.5, 24.8]), // Taiwan
  R(0.7, 0.5, [128.5, 38.5], [128.8, 36]), // Taebaek
  R(0.9, 0.7, [136.5, 35], [138, 36], [140, 38.5], [140.5, 40.5]), // Japanese Alps
  R(0.7, 0.5, [142.5, 43.5], [143, 42.5]), // Hokkaido
  // ── Siberia / Far East
  R(1.3, 0.55, [120, 55.5], [128, 55], [135, 56]), // Stanovoy
  R(2.0, 0.6, [128, 63], [130, 67], [132, 70]), // Verkhoyansk
  R(2.0, 0.6, [138, 62], [143, 66], [148, 68]), // Chersky
  R(2.0, 0.55, [155, 62], [165, 64], [172, 66]), // Kolyma / Anadyr
  R(1.2, 0.8, [156, 51], [158, 55], [161, 58], [164, 61]), // Kamchatka
  R(1.4, 0.45, [95, 67], [100, 69]), // Putorana
  // ── South / SE Asia
  R(1.0, 0.6, [93.5, 25], [94, 22], [94.5, 18]), // Arakan
  R(1.0, 0.5, [98.5, 20], [99, 16]), // Shan / Tenasserim
  R(1.0, 0.6, [104, 19], [106, 16.5], [108, 13.5]), // Annamite
  R(0.8, 0.5, [73.5, 19], [74.5, 15], [76.5, 10]), // Western Ghats
  R(0.8, 0.5, [121, 17.5], [121, 15]), // Luzon Cordillera
  R(1.0, 0.7, [95.5, 4.5], [99, 1], [102, -3], [104.5, -5.5]), // Barisan
  R(1.4, 0.5, [116, 5.5], [115, 2], [114, 0]), // Borneo
  R(1.5, 0.9, [134, -3.8], [138, -4.2], [141, -5], [144, -6], [147, -7.5]), // New Guinea
  // ── Arabia / Africa
  R(1.0, 0.6, [43.5, 13.5], [44, 16], [43.5, 18]), // Yemen highlands
  R(1.0, 0.5, [38, 27], [40, 22], [42, 18]), // Hejaz
  R(1.0, 0.55, [56, 23.5], [58.5, 22.8]), // Hajar
  R(1.3, 0.85, [-9.5, 30.5], [-7, 31.3], [-4.5, 32.5], [-1, 33.5], [3, 35.5], [7, 35.5], [9.5, 36]), // Atlas
  R(2.5, 0.85, [37.5, 14], [38.5, 11], [38, 8], [39.5, 6.5]), // Ethiopian highlands
  R(1.5, 0.7, [40, 9], [42.5, 9.2]), // Harar
  R(1.0, 0.7, [29.5, 1], [29.8, -3]), // Rwenzori / rift
  R(1.2, 0.7, [36.5, 0.5], [37.5, -3.2]), // Kenya highlands / Kilimanjaro
  R(1.2, 0.75, [27, -31.5], [29.5, -29.5], [30.5, -27]), // Drakensberg
  R(0.8, 0.5, [9.5, 4.2], [11, 6.5], [13.5, 7.5]), // Cameroon line
  R(2.0, 0.6, [5.5, 23.5], [6, 23]), // Ahaggar
  R(2.0, 0.6, [17.5, 21], [18.5, 20.5]), // Tibesti
  R(1.3, 0.6, [47, -13], [47, -18], [46.5, -23]), // Madagascar spine
  R(1.2, 0.4, [14, -12], [15, -15], [16, -19]), // Angolan plateau rim
  // ── North America
  R(1.5, 0.9, [-153, 62], [-148, 63], [-142, 61.5]), // Alaska Range
  R(1.2, 0.6, [-160, 68], [-150, 68.3], [-142, 68.8]), // Brooks
  R(1.6, 0.8, [-140, 60.5], [-135, 59], [-127, 53], [-122, 49.5]), // Coast Mountains
  R(2.6, 0.95, [-130, 61], [-122, 55], [-116, 50], [-112, 46], [-110, 43], [-106.5, 39], [-106, 35], [-105.5, 32]), // Rockies
  R(1.0, 0.8, [-121.5, 48.5], [-121.8, 44], [-121, 40], [-119, 37], [-118, 35.5]), // Cascades / Sierra Nevada
  R(3.0, 0.45, [-117, 40], [-112, 38]), // Great Basin ranges
  R(1.6, 0.75, [-108.5, 30], [-105.5, 25], [-103, 21]), // Sierra Madre Occidental
  R(1.1, 0.65, [-101, 27], [-99.5, 23], [-97.5, 19.5]), // Sierra Madre Oriental
  R(0.8, 0.8, [-104, 19.5], [-98, 19.2], [-96.5, 19]), // Trans-Mexican volcanic belt
  R(1.0, 0.7, [-97, 17], [-92, 15.5], [-88, 14.5], [-85, 13], [-84, 10]), // Central America
  R(1.6, 0.55, [-85.5, 34], [-82.5, 36.5], [-79.5, 38.5], [-77, 40.5], [-74.5, 42], [-72.5, 44], [-70, 45.5], [-67, 47]), // Appalachians
  R(1.0, 0.4, [-64, 59], [-63.5, 56]), // Torngat
  R(1.2, 0.5, [-70, 70], [-65, 67]), // Baffin
  R(2.0, 0.55, [-30, 68], [-25, 71], [-22, 74]), // East Greenland
  // ── South America
  R(2.0, 1.0, [-75, 10], [-73, 7], [-76, 3], [-78, -1], [-79, -5], [-76.5, -10], [-73.5, -14], [-70, -17], [-68.5, -22],
    [-68.5, -27], [-70, -31], [-70.3, -35], [-71, -40], [-72, -45], [-73, -49], [-72.5, -53]), // Andes
  R(2.5, 0.8, [-68.5, -15.5], [-67.5, -20], [-67, -23]), // Altiplano
  R(0.8, 0.6, [-72, 8.5], [-67, 10.3], [-64, 10.4]), // Venezuelan coastal range
  R(1.5, 0.45, [-45, -22.5], [-42, -20], [-41, -17]), // Serra do Mar / Mantiqueira
  R(2.0, 0.45, [-64, 5], [-60, 5.2]), // Guiana highlands
  // ── Oceania
  R(1.8, 0.55, [145.3, -15], [146.5, -19], [148.5, -23], [151, -27], [152, -30], [150, -33], [149, -35.5], [147, -37]), // Great Dividing Range
  R(1.0, 0.7, [146.5, -37], [148.5, -36]), // Australian Alps
  R(1.0, 0.35, [132, -23.7], [135, -23.7]), // MacDonnell
  R(1.0, 0.35, [116, -23], [119, -22.5]), // Hamersley
  R(1.0, 0.9, [167, -46], [169.5, -44], [172, -42.3]), // Southern Alps
  R(0.8, 0.5, [175.5, -39.5], [176, -38.5]), // NZ North Island
];

/** Big lakes carved as water (rough outlines). */
export const LAKES: [number, number][][] = [
  [[-92.1, 46.7], [-89.5, 47.9], [-86.5, 48.8], [-84.8, 47.5], [-84.6, 46.5], [-87, 46.4], [-90, 46.6]], // Superior
  [[-87.8, 42], [-87.5, 44.5], [-87.6, 45.7], [-85.5, 46], [-85, 45.5], [-86.3, 43.5], [-86.6, 42]], // Michigan
  [[-84.5, 45.9], [-82, 46.1], [-80.5, 45.9], [-80, 44.5], [-81.7, 43.2], [-82.5, 43.5], [-83.5, 44.2], [-84.4, 45.3]], // Huron
  [[-83.4, 41.7], [-81, 42.6], [-79, 42.9], [-79, 42.4], [-81.5, 41.5]], // Erie
  [[-79.8, 43.3], [-79.5, 43.8], [-77, 44.2], [-76.2, 43.6], [-77.5, 43.3]], // Ontario
  [[31.8, 0], [33, 0.4], [34.2, 0.2], [34.8, -0.5], [33.8, -2.5], [32, -2.6], [31.6, -1.5]], // Victoria
  [[29.0, -3.3], [29.5, -3.3], [30.0, -5.5], [31.1, -8.0], [30.9, -8.8], [30.3, -8.3], [29.2, -6.0]], // Tanganyika
  [[34.2, -9.5], [34.8, -9.6], [35.3, -12.5], [35.3, -14.3], [34.8, -14.0], [34.3, -12], [33.9, -10.5]], // Malawi
  [[103.7, 51.5], [104.8, 51.6], [106.5, 52.6], [108.4, 53.5], [109.9, 55.5], [109.3, 55.9], [108, 54.2], [106, 53.3], [104.5, 52]], // Baikal
  [[30.5, 60], [32.8, 60.6], [32.6, 61.3], [30.5, 61.3], [30, 60.5]], // Ladoga
  [[34.5, 61], [36, 61.2], [36.2, 62.2], [35, 62.8], [34.7, 62]], // Onega
  [[-125.5, 65], [-122, 66.9], [-118.5, 66.3], [-120, 65], [-122.5, 64.8]], // Great Bear
  [[-117, 61], [-114, 62.5], [-110.5, 62.8], [-111, 61.8], [-115, 61.0]], // Great Slave
  [[-99.2, 50.4], [-96.6, 50.4], [-96.8, 52.2], [-97.8, 53.8], [-98.8, 53.5], [-98.5, 51.8]], // Winnipeg
  [[73.5, 46.4], [75, 45.9], [77, 45.8], [79.3, 46.2], [79.3, 46.9], [77, 46.6], [75, 46.8], [74, 47.0]], // Balkhash
];

/**
 * Straits forced to a 4-connected 1-tile water channel so ships pass and land attacks cannot.
 * Each is a polyline from sea to sea.
 */
export const STRAITS: { name: string; pts: [number, number][] }[] = [
  { name: 'Gibilterra', pts: [[-6.4, 35.95], [-5.6, 35.97], [-4.9, 36.05]] },
  { name: 'Manica', pts: [[0.6, 50.5], [1.45, 51.0], [2.2, 51.35]] },
  { name: 'Bosforo', pts: [[28.95, 40.85], [29.05, 41.1], [29.15, 41.35]] },
  { name: 'Dardanelli', pts: [[25.9, 40.0], [26.4, 40.15], [26.7, 40.4], [27.2, 40.55]] },
  { name: 'Bering', pts: [[-169.3, 64.8], [-168.9, 65.8], [-168.7, 66.8]] },
  { name: 'Øresund', pts: [[12.75, 55.25], [12.65, 55.75], [12.55, 56.2]] },
  { name: 'Messina', pts: [[15.55, 37.95], [15.62, 38.2], [15.7, 38.4]] },
  { name: 'Kerch', pts: [[36.45, 44.9], [36.55, 45.3], [36.65, 45.55]] },
  { name: 'Bab el-Mandeb', pts: [[43.2, 12.2], [43.4, 12.6], [43.4, 13.0]] },
  { name: 'Tsugaru', pts: [[139.9, 41.45], [140.7, 41.5], [141.6, 41.55]] },
  { name: 'Hormuz', pts: [[56.0, 26.2], [56.5, 26.45], [57.0, 26.2]] },
  { name: 'Singapore', pts: [[103.4, 1.15], [103.85, 1.2], [104.4, 1.3]] },
  { name: 'Palk', pts: [[79.2, 9.6], [79.6, 9.2], [80.0, 8.8]] },
];
