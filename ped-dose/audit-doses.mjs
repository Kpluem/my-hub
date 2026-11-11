/**
 * Dose audit for ped-dose/index.html.
 *
 * Loads the page in jsdom and checks every drug × regimen × frequency × weight
 * (plus age boundaries) against the regimen fields already in the file.
 *
 *   node ped-dose/audit-doses.mjs
 *   node ped-dose/audit-doses.mjs --out /tmp/dose-report.json
 *
 * Requires the `jsdom` package (NODE_PATH or a local install).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, 'index.html');
const rawHtml = readFileSync(htmlPath, 'utf8');

const WEIGHTS = [0.5, 3, 5, 10, 15, 20, 30, 33, 35, 40, 60, 70, 80, 100, 120];
const EPS = 1e-6;

function near(a, b, eps = EPS) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

function loadDrugs(html) {
  const start = html.indexOf('const DRUGS = ');
  const end = html.indexOf('// 2. STATE');
  if (start < 0 || end < 0) throw new Error('Could not locate the DRUGS array');
  const block = html.slice(start, end);
  return new Function(`${block}\nreturn DRUGS;`)();
}

function loadPage(html) {
  const stripped = html
    .replace(/<script\s+src="https:\/\/cdn\.tailwindcss\.com"><\/script>/, '')
    .replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/, '');
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (err) => errors.push(String(err)));
  const dom = new JSDOM(stripped, {
    url: 'http://localhost/ped-dose/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const w = dom.window;
  if (typeof w.calculateRecommendedRange !== 'function') {
    throw new Error('calculateRecommendedRange was not loaded: ' + errors.join('\n'));
  }
  return w;
}

function cap(value, limit) {
  return limit ? Math.min(value, limit) : value;
}

/** Expected mg range from regimen fields. Special rules follow the ref text in the file. */
function expectedRange(drug, regimen, pt, freq) {
  let minDoseMg = 0;
  let maxDoseMg = 0;
  let minDayMg = 0;
  let maxDayMg = 0;

  if (regimen.basis === 'per_day') {
    minDayMg = cap(pt.weight * regimen.min, regimen.maxDayMg);
    maxDayMg = cap(pt.weight * regimen.max, regimen.maxDayMg);
    minDoseMg = minDayMg / freq;
    maxDoseMg = maxDayMg / freq;
    if (regimen.maxDoseMg) {
      minDoseMg = Math.min(minDoseMg, regimen.maxDoseMg);
      maxDoseMg = Math.min(maxDoseMg, regimen.maxDoseMg);
      minDayMg = minDoseMg * freq;
      maxDayMg = maxDoseMg * freq;
    }
  } else if (regimen.basis === 'per_dose') {
    minDoseMg = cap(pt.weight * regimen.min, regimen.maxDoseMg);
    maxDoseMg = cap(pt.weight * regimen.max, regimen.maxDoseMg);
    if (regimen.maxDayMg) {
      minDoseMg = Math.min(minDoseMg, regimen.maxDayMg / freq);
      maxDoseMg = Math.min(maxDoseMg, regimen.maxDayMg / freq);
    }
    minDayMg = minDoseMg * freq;
    maxDayMg = maxDoseMg * freq;
  } else if (regimen.basis === 'domperidone_rule') {
    const lo = regimen.min;
    const hi = regimen.max;
    const doseCap = regimen.maxDoseMg || 10;
    if (pt.weight >= 35) {
      minDoseMg = doseCap;
      maxDoseMg = doseCap;
    } else {
      minDoseMg = Math.min(pt.weight * lo, doseCap);
      maxDoseMg = Math.min(pt.weight * hi, doseCap);
    }
    minDayMg = minDoseMg * freq;
    maxDayMg = maxDoseMg * freq;
    if (regimen.maxDayMg) {
      minDayMg = Math.min(minDayMg, regimen.maxDayMg);
      maxDayMg = Math.min(maxDayMg, regimen.maxDayMg);
      minDoseMg = minDayMg / freq;
      maxDoseMg = maxDayMg / freq;
    }
  } else if (regimen.basis === 'age_fixed_guaifenesin') {
    const yrs = pt.totalMonths / 12;
    if (yrs < 2) { minDoseMg = 25; maxDoseMg = 50; }
    else if (yrs < 6) { minDoseMg = 50; maxDoseMg = 100; }
    else if (yrs <= 12) { minDoseMg = 100; maxDoseMg = 200; }
    else { minDoseMg = 200; maxDoseMg = 400; }
    minDayMg = minDoseMg * freq;
    maxDayMg = maxDoseMg * freq;
  } else if (regimen.basis === 'oseltamivir_rule') {
    if (pt.totalMonths < 3) { minDoseMg = 12; maxDoseMg = 12; }
    else if (pt.totalMonths <= 5) { minDoseMg = 20; maxDoseMg = 20; }
    else if (pt.totalMonths <= 11) { minDoseMg = 25; maxDoseMg = 25; }
    else if (pt.weight < 15) { minDoseMg = 30; maxDoseMg = 30; }
    else if (pt.weight <= 23) { minDoseMg = 45; maxDoseMg = 45; }
    else if (pt.weight <= 40) { minDoseMg = 60; maxDoseMg = 60; }
    else { minDoseMg = 75; maxDoseMg = 75; }
    minDayMg = minDoseMg * freq;
    maxDayMg = maxDoseMg * freq;
  } else {
    throw new Error('Unknown basis ' + regimen.basis);
  }

  return { minDoseMg, maxDoseMg, minDayMg, maxDayMg };
}

function finitePair(range) {
  return [range.minDoseMg, range.maxDoseMg, range.minDayMg, range.maxDayMg].every(Number.isFinite);
}

function scenariosFor(drug, regimen) {
  const ages = [{ y: 4, m: 0 }];
  if (drug.id === 'guaifenesin' || regimen.basis === 'age_fixed_guaifenesin') {
    ages.push(
      { y: 0, m: 0 }, { y: 1, m: 11 }, { y: 2, m: 0 }, { y: 5, m: 11 },
      { y: 6, m: 0 }, { y: 12, m: 0 }, { y: 12, m: 1 }, { y: 13, m: 0 }
    );
  }
  if (drug.id === 'oseltamivir_cap' || regimen.basis === 'oseltamivir_rule') {
    ages.push(
      { y: 0, m: 0 }, { y: 0, m: 2 }, { y: 0, m: 3 }, { y: 0, m: 5 },
      { y: 0, m: 6 }, { y: 0, m: 11 }, { y: 1, m: 0 }
    );
  }
  if (drug.id === 'cotrimoxazole') ages.push({ y: 0, m: 1 }, { y: 0, m: 2 }, { y: 0, m: 3 });
  if (drug.id === 'tazocin_iv') ages.push({ y: 0, m: 6 }, { y: 0, m: 7 });

  const seen = new Set();
  const out = [];
  for (const freq of regimen.freqs) {
    for (const weight of WEIGHTS) {
      for (const age of ages) {
        const key = `${freq}|${weight}|${age.y}|${age.m}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ freq, weight, ageY: age.y, ageM: age.m, totalMonths: age.y * 12 + age.m });
      }
    }
  }
  return out;
}

function keyOf(row) {
  return [row.drug, row.regimen, row.freq, row.weight, row.ageY, row.ageM].join('|');
}

function audit(window, drugs) {
  const rows = [];
  const failures = [];
  const notes = [];

  function fail(row, message) {
    failures.push({ ...row, message });
  }

  for (const drug of drugs) {
    if (drug.category === 'liquid' && !(drug.mgPerMl > 0)) {
      notes.push(`${drug.id}: liquid is missing a positive mgPerMl`);
    }
    if (!drug.regimens?.length) notes.push(`${drug.id}: no regimens`);
    for (const regimen of drug.regimens) {
      if (!(regimen.min == null) && regimen.min > regimen.max) {
        notes.push(`${drug.id}/${regimen.id}: regimen.min ${regimen.min} > regimen.max ${regimen.max} (data)`);
      }
      if (!regimen.freqs.includes(regimen.defaultFreq)) {
        fail(
          { drug: drug.id, regimen: regimen.id },
          `defaultFreq ${regimen.defaultFreq} is not in freqs ${regimen.freqs.join(',')}`
        );
      }
      for (const sc of scenariosFor(drug, regimen)) {
        const pt = {
          weight: sc.weight,
          ageY: sc.ageY,
          ageM: sc.ageM,
          totalMonths: sc.totalMonths,
          days: 5,
          valid: true,
          errors: [],
        };
        const got = window.calculateRecommendedRange(drug, regimen, pt, sc.freq);
        const want = expectedRange(drug, regimen, pt, sc.freq);
        const conc = drug.category === 'liquid'
          ? drug.mgPerMl
          : (drug.category === 'solid' ? drug.defaultPrepConc : drug.defaultReconConc);
        const row = {
          drug: drug.id,
          name: drug.name,
          regimen: regimen.id,
          basis: regimen.basis,
          freq: sc.freq,
          weight: sc.weight,
          ageY: sc.ageY,
          ageM: sc.ageM,
          minDoseMg: got.minDoseMg,
          maxDoseMg: got.maxDoseMg,
          minDayMg: got.minDayMg,
          maxDayMg: got.maxDayMg,
          minMl: conc ? got.minDoseMg / conc : null,
          maxMl: conc ? got.maxDoseMg / conc : null,
          warning: got.warning || '',
        };
        rows.push(row);

        if (!finitePair(got)) {
          fail(row, `non-finite result ${JSON.stringify(got)}`);
          continue;
        }
        if (got.minDoseMg > got.maxDoseMg + EPS) {
          fail(row, `reversed per-dose range ${got.minDoseMg} > ${got.maxDoseMg}`);
        }
        if (got.minDayMg > got.maxDayMg + EPS) {
          fail(row, `reversed daily range ${got.minDayMg} > ${got.maxDayMg}`);
        }
        if (!near(got.minDayMg, got.minDoseMg * sc.freq) || !near(got.maxDayMg, got.maxDoseMg * sc.freq)) {
          fail(row, `daily total is not per-dose × freq (min ${got.minDayMg} vs ${got.minDoseMg * sc.freq}, max ${got.maxDayMg} vs ${got.maxDoseMg * sc.freq})`);
        }
        if (regimen.maxDoseMg && got.maxDoseMg > regimen.maxDoseMg + EPS) {
          fail(row, `per-dose max ${got.maxDoseMg} exceeds maxDoseMg ${regimen.maxDoseMg}`);
        }
        if (regimen.maxDayMg && got.maxDayMg > regimen.maxDayMg + EPS) {
          fail(row, `daily max ${got.maxDayMg} exceeds maxDayMg ${regimen.maxDayMg}`);
        }
        if (!near(got.minDoseMg, want.minDoseMg) || !near(got.maxDoseMg, want.maxDoseMg)
          || !near(got.minDayMg, want.minDayMg) || !near(got.maxDayMg, want.maxDayMg)) {
          fail(row, `expected ${want.minDoseMg}–${want.maxDoseMg} mg/dose (${want.minDayMg}–${want.maxDayMg} mg/day), got ${got.minDoseMg}–${got.maxDoseMg} mg/dose (${got.minDayMg}–${got.maxDayMg} mg/day)`);
        }
        if (conc) {
          if (!near(row.minMl, got.minDoseMg / conc) || !near(row.maxMl, got.maxDoseMg / conc)) {
            fail(row, 'ml is not mg / concentration');
          }
        }
        const shownMin = window.fmt(got.minDoseMg, 1);
        const shownMax = window.fmt(got.maxDoseMg, 1);
        const nMin = Number(String(shownMin).replace(/,/g, ''));
        const nMax = Number(String(shownMax).replace(/,/g, ''));
        if (got.minDoseMg <= got.maxDoseMg && nMin > nMax + 0.05) {
          fail(row, `display rounds to a reversed range ${shownMin} – ${shownMax}`);
        }
      }
    }
  }

  return { rows, failures, notes };
}

function setPatient(window, { weight, years, months, days }) {
  const doc = window.document;
  if (weight !== undefined) doc.getElementById('ptWeight').value = weight;
  if (years !== undefined) doc.getElementById('ptAgeY').value = years;
  if (months !== undefined) doc.getElementById('ptAgeM').value = months;
  if (days !== undefined) doc.getElementById('ptDays').value = days;
}

function text(window, id) {
  return window.document.getElementById(id)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function uiChecks(window) {
  const problems = [];
  const snapshots = [];

  function snap(label) {
    snapshots.push({
      label,
      mg: text(window, 'rangeMgPerDose'),
      mgSub: text(window, 'rangeMgPerDoseSub'),
      day: text(window, 'rangeMgPerDay'),
      daySub: text(window, 'rangeMgPerDaySub'),
      ml: text(window, 'rangeMlPerDose'),
      order: window.document.getElementById('rxOrderInput')?.value ?? '',
      unit: window.document.getElementById('rxUnitSelect')?.value ?? '',
      check: text(window, 'rxValidationBox').slice(0, 180),
      alert: text(window, 'patientValidationAlert'),
    });
  }

  // Empty / zero / invalid weight must block every output.
  for (const [value, label] of [['', 'empty'], ['0', 'zero'], ['-2', 'negative'], ['abc', 'text'], ['0.4', 'below-range'], ['121', 'above-range']]) {
    window.selectDrug('ibuprofen');
    setPatient(window, { weight: value, years: '4', months: '0', days: '5' });
    window.onPatientInputChange();
    const mg = text(window, 'rangeMgPerDose');
    const alert = text(window, 'patientValidationAlert');
    const step3 = text(window, 'step3Container');
    if (mg !== '—' || !alert || /mg/.test(text(window, 'rangeMlPerDose')) || !step3.includes('ยังไม่คำนวณ')) {
      problems.push(`weight ${label} (${JSON.stringify(value)}) did not block output: mg=${mg} alert=${alert} step3=${step3.slice(0, 80)}`);
    }
  }

  // Ibuprofen 15 kg, freq 3 and 4. Liquid stays on ml/ครั้ง.
  window.selectDrug('ibuprofen');
  setPatient(window, { weight: '15', years: '4', months: '0', days: '5' });
  window.onPatientInputChange();
  window.onFreqChange('3');
  snap('ibuprofen-15-freq3');
  const ibu3 = snapshots.at(-1);
  if (!ibu3.mg.startsWith('75') || !ibu3.mg.includes('150') || !ibu3.ml.includes('3.75') || !ibu3.ml.includes('7.5')) {
    problems.push(`ibuprofen 15 kg freq 3 display: ${ibu3.mg} / ${ibu3.ml}`);
  }
  if (ibu3.unit !== 'ml_dose') problems.push(`ibuprofen default unit is ${ibu3.unit}, expected ml_dose`);
  window.fillDoctorOrder('min');
  const minMl = Number(window.document.getElementById('rxOrderInput').value);
  window.fillDoctorOrder('max');
  const maxMl = Number(window.document.getElementById('rxOrderInput').value);
  window.fillDoctorOrder('mid');
  const midMl = Number(window.document.getElementById('rxOrderInput').value);
  if (!(minMl <= midMl && midMl <= maxMl) || !near(minMl, 3.75) || !near(maxMl, 7.5)) {
    problems.push(`ibuprofen Min/Mid/Max ml = ${minMl}, ${midMl}, ${maxMl}`);
  }
  if (!text(window, 'rxValidationBox').includes('เหมาะสม')) {
    problems.push('ibuprofen mid should validate as optimal: ' + text(window, 'rxValidationBox').slice(0, 120));
  }

  // ml ↔ mg ↔ mg/day for the same 150 mg dose.
  window.onDoctorUnitChange('mg_dose');
  window.onDoctorOrderInput('150');
  if (!text(window, 'rxValidationBox').includes('150 mg')) {
    problems.push('mg order 150 was not read as 150 mg: ' + text(window, 'rxValidationBox').slice(0, 160));
  }
  window.onDoctorUnitChange('ml_dose');
  window.onDoctorOrderInput('7.5');
  if (!text(window, 'rxValidationBox').includes('150 mg')) {
    problems.push('7.5 ml was not read as 150 mg: ' + text(window, 'rxValidationBox').slice(0, 160));
  }
  window.onDoctorUnitChange('mg_day');
  window.onDoctorOrderInput('450');
  if (!text(window, 'rxValidationBox').includes('150 mg')) {
    problems.push('450 mg/day was not read as 150 mg/dose: ' + text(window, 'rxValidationBox').slice(0, 160));
  }

  window.onFreqChange('4');
  snap('ibuprofen-15-freq4');
  const ibu4 = snapshots.at(-1);
  if (!ibu4.mg.includes('75') || !ibu4.mg.includes('150') || !ibu4.day.includes('300') || !ibu4.day.includes('600') || !ibu4.ml.includes('3.75') || !ibu4.ml.includes('7.5')) {
    problems.push(`ibuprofen 15 kg freq 4 display: ${ibu4.mg} / ${ibu4.day} / ${ibu4.ml}`);
  }

  // Paracetamol, including weights where 4000 mg/day binds.
  for (const [kg, freq, expectMg] of [
    ['15', '4', '150 – 225 mg'],
    ['15', '6', '150 – 225 mg'],
    ['40', '4', '400 – 600 mg'],
    ['40', '6', '400 – 600 mg'],
    ['70', '4', '700 – 1,000 mg'],
    ['70', '6', '666.7 mg'],
    ['80', '4', '800 – 1,000 mg'],
    ['80', '6', '666.7 mg'],
  ]) {
    window.selectDrug('paracetamol');
    setPatient(window, { weight: kg, years: '10', months: '0', days: '5' });
    window.onPatientInputChange();
    window.onFreqChange(freq);
    const mg = text(window, 'rangeMgPerDose');
    const day = text(window, 'rangeMgPerDay');
    snap(`paracetamol-${kg}-freq${freq}`);
    if (mg !== expectMg) problems.push(`paracetamol ${kg} kg freq ${freq}: mg display ${JSON.stringify(mg)} expected ${JSON.stringify(expectMg)}`);
    if (freq === '4' && kg === '70' && day !== '2,800 – 4,000 mg') {
      problems.push(`paracetamol 70 kg freq 4 daily display ${day}`);
    }
    if ((kg === '70' || kg === '80') && freq === '6' && day !== '4,000 mg') {
      problems.push(`paracetamol ${kg} kg freq 6 daily display ${day}`);
    }
  }

  // Tazocin extended 20 kg.
  window.selectDrug('tazocin_iv');
  window.selectRegimen('extended');
  setPatient(window, { weight: '20', years: '6', months: '0', days: '5' });
  window.onPatientInputChange();
  window.onFreqChange('3');
  snap('tazocin-extended-20-freq3');
  const taz = snapshots.at(-1);
  if (taz.mg !== '2,000 mg' || taz.day !== '6,000 mg' || taz.ml !== '10 ml') {
    problems.push(`tazocin extended 20 kg freq 3: ${taz.mg} / ${taz.day} / ${taz.ml}`);
  }
  window.onFreqChange('4');
  snap('tazocin-extended-20-freq4');
  const taz4 = snapshots.at(-1);
  if (taz4.mg !== '2,000 mg' || taz4.day !== '8,000 mg' || taz4.ml !== '10 ml') {
    problems.push(`tazocin extended 20 kg freq 4: ${taz4.mg} / ${taz4.day} / ${taz4.ml}`);
  }

  // Augmentin concentration is amoxicillin 80 mg/ml, not amox+clavulanate.
  window.selectDrug('augmentin');
  setPatient(window, { weight: '15', years: '4', months: '0', days: '5' });
  window.onPatientInputChange();
  window.onFreqChange('2');
  snap('augmentin-15-freq2');
  const aug = snapshots.at(-1);
  if (aug.mg !== '150 – 375 mg' || aug.ml !== '1.88 – 4.69 ml') {
    problems.push(`augmentin 15 kg freq 2: ${aug.mg} / ${aug.ml}`);
  }

  // Co-trimoxazole concentration is TMP 8 mg/ml.
  window.selectDrug('cotrimoxazole');
  setPatient(window, { weight: '15', years: '4', months: '0', days: '5' });
  window.onPatientInputChange();
  snap('cotrim-15');
  const cot = snapshots.at(-1);
  if (cot.mg !== '60 – 90 mg' || cot.ml !== '7.5 – 11.25 ml') {
    problems.push(`co-trimoxazole 15 kg: ${cot.mg} / ${cot.ml}`);
  }

  // Solid preparation cannot drop below the volume needed for the course.
  window.selectDrug('azithromycin_cap');
  setPatient(window, { weight: '15', years: '4', months: '0', days: '5' });
  window.onPatientInputChange();
  const prepBefore = text(window, 'step3Container');
  const minCaps = Number((prepBefore.match(/ขั้นต่ำ\s+(\d+)/) || [])[1]);
  window.adjustPrepUnits(-1, minCaps);
  window.adjustPrepUnits(-1, minCaps);
  const prepAfter = text(window, 'step3Container');
  const used = Number((prepAfter.match(/ใช้\s+(\d+)/) || [])[1]);
  const qs = Number((prepAfter.match(/([\d.]+)\s*ml/) || [])[1]);
  const per = Number((prepAfter.match(/([\d.]+)\s*ml\/ครั้ง/) || [])[1]);
  if (!(minCaps >= 1) || used < minCaps || !(qs + 1e-6 >= per * 1 * 5)) {
    problems.push(`azithromycin prep floor failed: min ${minCaps}, used ${used}, qs ${qs} ml, per dose ${per} ml`);
  }

  // Days: 0 must not be treated as the default 5. Empty still defaults to 5.
  window.selectDrug('amox_syr');
  setPatient(window, { weight: '12', years: '2', months: '0', days: '0' });
  window.onPatientInputChange();
  const zeroDayText = text(window, 'step3Container');
  setPatient(window, { weight: '12', years: '2', months: '0', days: '' });
  window.onPatientInputChange();
  const emptyDayText = text(window, 'step3Container');
  setPatient(window, { weight: '12', years: '2', months: '0', days: '5' });
  window.onPatientInputChange();
  const fiveDayText = text(window, 'step3Container');
  if (zeroDayText === fiveDayText) {
    problems.push('days=0 produced the same dispense text as days=5');
  }
  if (emptyDayText !== fiveDayText) {
    problems.push('empty days field should keep the 5-day default');
  }

  return { problems, snapshots };
}

function main() {
  const drugs = loadDrugs(rawHtml);
  const window = loadPage(rawHtml);
  const { rows, failures, notes } = audit(window, drugs);
  const ui = uiChecks(window);

  const byDrug = new Map();
  for (const f of failures) {
    const id = f.drug || '?';
    if (!byDrug.has(id)) byDrug.set(id, []);
    byDrug.get(id).push(f);
  }

  const summary = {
    drugs: drugs.length,
    rows: rows.length,
    failureCount: failures.length,
    uiProblemCount: ui.problems.length,
    failingDrugs: [...byDrug.keys()],
  };

  console.log(JSON.stringify(summary, null, 2));
  console.log('\n# Calculation failures');
  if (failures.length === 0) console.log('none');
  for (const [drug, list] of byDrug) {
    console.log(`\n## ${drug} (${list.length})`);
    const shown = list.slice(0, 8);
    for (const f of shown) {
      console.log(`- ${f.regimen} freq ${f.freq} ${f.weight} kg age ${f.ageY}y${f.ageM}m: ${f.message}`);
    }
    if (list.length > shown.length) console.log(`- … ${list.length - shown.length} more`);
  }
  console.log('\n# UI problems');
  if (ui.problems.length === 0) console.log('none');
  for (const p of ui.problems) console.log('- ' + p);
  console.log('\n# Notes');
  if (notes.length === 0) console.log('none');
  for (const n of notes) console.log('- ' + n);

  const outIdx = process.argv.indexOf('--out');
  if (outIdx !== -1) {
    const dest = process.argv[outIdx + 1];
    writeFileSync(dest, JSON.stringify({ summary, failures, notes, ui, rows }, null, 2));
    console.log(`\nWrote ${dest}`);
  }

  if (failures.length || ui.problems.length) process.exitCode = 1;
}

main();
