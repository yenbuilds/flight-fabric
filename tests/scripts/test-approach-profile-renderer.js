#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const repoRoot = path.join(__dirname, '..', '..');
const FT_PER_DEG_LAT = 364567;

function frontendUrl(...segments) {
  return pathToFileURL(path.join(repoRoot, 'frontend', ...segments)).href;
}

function assertNoBadNumbers(svg, label) {
  assert.doesNotMatch(svg, /NaN/, `${label} should not contain NaN`);
  assert.doesNotMatch(svg, /Infinity/, `${label} should not contain Infinity`);
}

function findTopdownWindVector(svg) {
  return svg.match(/<g\b[^>]*\bdata-topdown-wind-vector="true"[^>]*>/)?.[0] || null;
}

function getSvgAttribute(tag, name) {
  if (!tag) return null;
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : null;
}

function profilePoint({
  alongFt,
  crossFt,
  raFt,
  altMslFt,
  altCalibratedFt = null,
  altPlaneFt = null,
  profileAltitudeFt = null,
  profileAltMslFt = null,
  profileAltitudeSource = null,
  dtMs = 5000,
}) {
  return {
    raFt,
    altMslFt,
    altCalibratedFt,
    altPlaneFt,
    profileAltitudeFt,
    profileAltMslFt,
    profileAltitudeSource,
    vsFpm: -650,
    iasKts: 135,
    gsKts: 135,
    dtMs,
    pitchDeg: 3,
    bankDeg: 0,
    headingDeg: 90,
    latDeg: crossFt / FT_PER_DEG_LAT,
    lonDeg: alongFt / FT_PER_DEG_LAT,
  };
}

async function main() {
  const { approachProfileApi } = await import(frontendUrl('src', 'landing', 'approach-profile-global.js'));
  const { buildLandingApproachProfileHtml } = await import(frontendUrl('src', 'timeline', 'landing-detail.js'));
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      passed += 1;
      console.log(`  PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${name}`);
      console.error(`    ${error.message}`);
    }
  }

  console.log('\nApproach Profile Renderer');

  test('side-on renderer uses height above threshold and touchdown annotations', () => {
    const profile = [
      profilePoint({ alongFt: -6000, crossFt: -40, raFt: 1180, altMslFt: 6200 }),
      profilePoint({ alongFt: -4500, crossFt: -40, raFt: 900, altMslFt: 5900 }),
      profilePoint({ alongFt: -3000, crossFt: -40, raFt: 600, altMslFt: 5600 }),
      profilePoint({ alongFt: -1500, crossFt: -40, raFt: 300, altMslFt: 5300 }),
      profilePoint({ alongFt: 1200, crossFt: -40, raFt: 20, altMslFt: 5020 }),
    ];
    const svg = approachProfileApi.buildSvg(profile, {
      vs_fpm: -620,
      pitch_deg: 3.2,
      grade: 'Good',
      color: '#00e070',
      thresholdElevFt: 5000,
      touchdownDistance: {
        distanceFt: 1200,
        grade: 'Good',
        score: 88,
      },
    });

    assert.match(svg, /^<svg\b/, 'expected SVG markup');
    assert.match(svg, /Altitude \(ft above rwy ref\)/, 'should prefer runway-relative height when altitude and runway references are present');
    assert.match(svg, /1,200 ft/, 'should render rounded touchdown distance label');
    assert.match(svg, /-620 fpm/, 'should render touchdown vertical speed');
    assert.match(svg, />TD RATE GOOD</, 'should explicitly scope the touchdown-rate grade annotation');
    assertNoBadNumbers(svg, 'side-on SVG');

    const cappedSvg = approachProfileApi.buildSvg(profile, {
      vs_fpm: -243,
      grade: 'PERFECT',
      thresholdElevFt: 5000,
      touchdownDistance: {
        distanceFt: 600,
        grade: 'Outstanding',
        bounceCount: 1,
        bounceGrade: 'Single Bounce',
      },
      ultimateStability: { verdict: 'unstable', score: 84, gateStable: false },
    });
    assert.match(cappedSvg, />TD RATE PERFECT</, 'approach annotation should preserve the explicitly scoped touchdown grade');
    assert.match(cappedSvg, />APP UNSTABLE · BNC 1x</, 'approach annotation should expose gate and bounce as peer facts');
    assert.match(cappedSvg, />Approach score 84%</, 'approach annotation should label the secondary percentage');

    const scoreOnlySvg = approachProfileApi.buildSvg(profile, {
      vs_fpm: -280,
      grade: 'GOOD',
      thresholdElevFt: 5000,
      ultimateStability: { score: 91 },
    });
    assert.match(scoreOnlySvg, />APP NO VERDICT</, 'a score-only approach annotation should explicitly state that no verdict is available');
    assert.match(scoreOnlySvg, />Approach score 91%</, 'the score-only annotation should retain the labelled secondary percentage');

    const peerFactsWithoutGradeSvg = approachProfileApi.buildSvg(profile, {
      thresholdElevFt: 5000,
      runwayExcursion: true,
      bounceCount: 1,
      bounceGrade: 'Single Bounce',
      ultimateStability: { verdict: 'unstable', score: 84, gateStable: false },
    });
    assert.doesNotMatch(peerFactsWithoutGradeSvg, /TD RATE/, 'missing touchdown-rate grades should not be invented');
    assert.match(peerFactsWithoutGradeSvg, />APP UNSTABLE · BNC 1x</, 'approach and bounce facts should render without a touchdown-rate grade');
    assert.match(peerFactsWithoutGradeSvg, />Approach score 84%</, 'approach score should render without a touchdown-rate grade');
    assert.match(peerFactsWithoutGradeSvg, />RUNWAY EXCURSION</, 'runway excursion should render as a separate critical fact');
  });

  test('timeline side-on handoff retains the separate runway-excursion fact', () => {
    const profile = [
      profilePoint({ alongFt: -6000, crossFt: 0, raFt: 1180, altMslFt: 6200 }),
      profilePoint({ alongFt: -4500, crossFt: 0, raFt: 900, altMslFt: 5900 }),
      profilePoint({ alongFt: -3000, crossFt: 0, raFt: 600, altMslFt: 5600 }),
      profilePoint({ alongFt: -1500, crossFt: 0, raFt: 300, altMslFt: 5300 }),
      profilePoint({ alongFt: 600, crossFt: 0, raFt: 20, altMslFt: 5020 }),
    ];
    let handedLanding = null;
    const fakeApi = {
      MIN_PROFILE_POINTS: 5,
      buildSvg(_profile, landing) {
        handedLanding = landing;
        return '<svg></svg>';
      },
    };
    const html = buildLandingApproachProfileHtml({
      type: 'landing',
      approachProfile: profile,
      grade: 'GOOD',
      runwayExcursion: true,
    }, fakeApi);

    assert.equal(html, '<svg></svg>');
    assert.equal(handedLanding?.grade, 'GOOD', 'timeline handoff should retain the touchdown-rate grade');
    assert.equal(handedLanding?.runwayExcursion, true, 'timeline handoff should retain excursion separately');
    assert.equal(Object.prototype.hasOwnProperty.call(handedLanding || {}, 'headlineGrade'), false, 'timeline handoff should not carry a hybrid headline grade');
  });

  test('side-on renderer honors an approach-locked calibrated reference through a cockpit jump', () => {
    const calibrated = [1200, 900, 600, 300, 20];
    const indicated = [1200, 600, 850, 300, 20];
    const profile = [-6000, -4500, -3000, -1500, 1000].map((alongFt, index) => profilePoint({
      alongFt,
      crossFt: 0,
      raFt: calibrated[index],
      altMslFt: indicated[index] + 5000,
      altCalibratedFt: calibrated[index] + 5000,
      profileAltMslFt: calibrated[index] + 5000,
      profileAltitudeSource: 'calibrated',
    }));
    const svg = approachProfileApi.buildSvg(profile, {
      thresholdElevFt: 5000,
      touchdownDistance: { distanceFt: 1000, grade: 'Good', score: 90 },
    });

    assert.match(svg, /Altitude \(ft above rwy ref\)/, 'calibrated fallback should drive the runway-relative axis');
    assert.doesNotMatch(svg, />1500<\/text>/, 'legacy indicated jump must not expand the calibrated altitude scale');
    assertNoBadNumbers(svg, 'calibrated-reference SVG');
  });

  test('side-on renderer prefers locked geometric altitude over changing barometric altitude', () => {
    const geometric = [1200, 900, 600, 300, 20];
    const calibrated = [1200, 700, 850, 300, 20];
    const profile = [-6000, -4500, -3000, -1500, 1000].map((alongFt, index) => profilePoint({
      alongFt,
      crossFt: 0,
      raFt: geometric[index],
      altMslFt: calibrated[index] + 5000,
      altCalibratedFt: calibrated[index] + 5000,
      altPlaneFt: geometric[index] + 5000,
      profileAltitudeFt: geometric[index] + 5000,
      profileAltMslFt: geometric[index] + 5000,
      profileAltitudeSource: 'plane',
    }));
    const svg = approachProfileApi.buildSvg(profile, {
      runwayReferenceElevFt: 5000,
      touchdownDistance: { distanceFt: 1000, grade: 'Good', score: 90 },
    });

    assert.match(svg, /Altitude \(ft above rwy ref\)/, 'geometric reference should drive the runway-relative axis');
    assert.doesNotMatch(svg, />1500<\/text>/, 'barometric jump must not expand the geometric altitude scale');
    assertNoBadNumbers(svg, 'geometric-reference SVG');
  });

  test('locked altitude source never falls through to radio or cockpit altitude per point', () => {
    const profile = [1200, 900, 600, 300, 20].map((heightFt, index) => profilePoint({
      alongFt: -6000 + (index * 1750),
      crossFt: 0,
      raFt: index === 2 ? 2400 : heightFt,
      altMslFt: 9000 + heightFt,
      altPlaneFt: index === 2 ? null : 5000 + heightFt,
      profileAltitudeFt: index === 2 ? null : 5000 + heightFt,
      profileAltMslFt: index === 2 ? null : 5000 + heightFt,
      profileAltitudeSource: 'plane',
    }));
    const resolver = approachProfileApi.createProfileHeightResolver(profile, 5000);

    assert.equal(resolver.source, 'plane', 'backend-locked geometric source should remain authoritative');
    assert.equal(resolver.usesRunwayReference, true, 'locked geometric source should use the runway datum');
    assert.equal(resolver.heightOf(profile[1]), 900, 'available geometric sample should be runway relative');
    assert.equal(resolver.heightOf(profile[2]), null, 'missing geometric sample must not borrow divergent RA or indicated altitude');

    const svg = approachProfileApi.buildSvg(profile, {
      runwayReferenceElevFt: 5000,
      touchdownDistance: { distanceFt: 1000, grade: 'Good', score: 90 },
    });
    assert.match(svg, /Altitude \(ft above rwy ref\)/, 'remaining samples should still use the locked runway-relative axis');
    assert.doesNotMatch(svg, />2500<\/text>/, 'divergent RA must not expand the geometric altitude scale');
    assertNoBadNumbers(svg, 'missing geometric sample SVG');
  });

  test('legacy altitude selection rejects a source that disappears at touchdown', () => {
    const profile = Array.from({ length: 10 }, (_, index) => ({
      raFt: 1000 - index * 100,
      altPlaneFt: index < 8 ? 1100 - index * 100 : null,
      altCalibratedFt: 1100 - index * 100,
      altMslFt: 1100 - index * 100,
      gsKts: 130,
      dtMs: 1000,
    }));

    const resolver = approachProfileApi.createProfileHeightResolver(profile, 100);
    assert.equal(resolver.source, 'calibrated', 'legacy fallback should require continuous touchdown coverage');
    assert.equal(resolver.heightOf(profile.at(-1)), 100, 'the selected datum should remain usable at touchdown');
  });

  test('side-on renderer escapes untrusted labels and rejects unsafe colors', () => {
    const profile = [
      profilePoint({ alongFt: -6000, crossFt: -40, raFt: 1180, altMslFt: 6200 }),
      profilePoint({ alongFt: -4500, crossFt: -40, raFt: 900, altMslFt: 5900 }),
      profilePoint({ alongFt: -3000, crossFt: -40, raFt: 600, altMslFt: 5600 }),
      profilePoint({ alongFt: -1500, crossFt: -40, raFt: 300, altMslFt: 5300 }),
      profilePoint({ alongFt: 1200, crossFt: -40, raFt: 20, altMslFt: 5020 }),
    ];
    const svg = approachProfileApi.buildSvg(
      profile,
      {
        vs_fpm: -610,
        grade: '<script>alert(1)</script>',
        color: 'url(javascript:alert(1))',
        thresholdElevFt: 5000,
        touchdownDistance: {
          distanceFt: 1200,
          grade: '<script>alert(1)</script>',
          score: 88,
        },
      },
      { idSuffix: '"><script>alert(1)</script>' }
    );

    assert.doesNotMatch(svg, /<script/i, 'should not emit raw script tags');
    assert.doesNotMatch(svg, /url\(javascript/i, 'should not emit unsafe CSS colors');
    assert.doesNotMatch(svg, /id="[^"]*[<>]/i, 'generated IDs should not contain raw tag characters');
    assert.match(svg, /&lt;SCRIPT&gt;ALERT\(1\)&lt;\/SCRIPT&gt;/, 'should render escaped grade text');
    assertNoBadNumbers(svg, 'sanitized side-on SVG');
  });

  test('side-on renderer handles short landings without bad coordinates', () => {
    const profile = [
      profilePoint({ alongFt: -6000, crossFt: 0, raFt: 1200, altMslFt: 1200 }),
      profilePoint({ alongFt: -4200, crossFt: 0, raFt: 850, altMslFt: 850 }),
      profilePoint({ alongFt: -2800, crossFt: 0, raFt: 560, altMslFt: 560 }),
      profilePoint({ alongFt: -1300, crossFt: 0, raFt: 260, altMslFt: 260 }),
      profilePoint({ alongFt: -250, crossFt: 0, raFt: 20, altMslFt: 20 }),
    ];
    const svg = approachProfileApi.buildSvg(profile, {
      vs_fpm: -740,
      grade: 'Short Landing',
      shortLanding: true,
      thresholdElevFt: 0,
      touchdownDistance: {
        distanceFt: -250,
        grade: 'Short Landing',
        score: 0,
      },
    });

    assert.match(svg, /SHORT OF THRESHOLD/, 'should render short landing warning');
    assert.match(svg, /-250 ft/, 'should render signed short-landing distance');
    assertNoBadNumbers(svg, 'short landing side-on SVG');
  });

  test('top-down GPS renderer keeps straight right-of-centerline tracks horizontal', () => {
    const profile = [-6000, -4000, -2000, -500, 1000].map((alongFt, index) =>
      profilePoint({
        alongFt,
        crossFt: -50,
        raFt: [1200, 900, 600, 250, 20][index],
        altMslFt: [1200, 900, 600, 250, 20][index],
      })
    );
    const svg = approachProfileApi.buildTopDownSvg(profile, {
      runwayHdg: 90,
      runway: '09',
      runwayThreshold: { lat: 0, lon: 0 },
      touchdownDistance: {
        distanceFt: 1000,
        lateralOffsetFt: 50,
        lateralOffsetSide: 'right',
        lateralOffsetGrade: 'Good',
        runwayWidthFt: 150,
        runwayLengthFt: 8000,
      },
    });

    assert.match(svg, /^<svg\b/, 'expected SVG markup');
    assert.match(svg, /RWY hdg: 90\.0/, 'should report runway heading');
    assert.match(svg, /GPS pts: 5\/5/, 'should use GPS projection branch');
    assert.match(svg, /THR: 0\.00000, 0\.00000/, 'should report threshold coordinates');
    assert.match(svg, /XT first: -50 ft\s+last: -50 ft/, 'right-of-centerline should stay negative in renderer convention');
    assert.match(svg, /50 ft r/, 'touchdown label should match right-side offset');
    assertNoBadNumbers(svg, 'top-down GPS SVG');

    const pathMatch = svg.match(/<path d="([^"]+)" fill="none" stroke="url\(#topPathGrad/);
    assert(pathMatch, 'expected top-down flight path');
    const yValues = [...pathMatch[1].matchAll(/[ML]\s+[-0-9.]+\s+([-0-9.]+)/g)]
      .map((match) => Number(match[1]));
    assert(yValues.length >= 5, 'expected y coordinate for every profile point');
    const ySpread = Math.max(...yValues) - Math.min(...yValues);
    assert(ySpread < 0.001, `straight right-offset path should be horizontal, spread=${ySpread}`);
  });

  test('top-down wind vector shows airflow for every runway-relative wind direction', () => {
    const profile = [-6000, -4000, -2000, -500, 1000].map((alongFt, index) =>
      profilePoint({
        alongFt,
        crossFt: 0,
        raFt: [1200, 900, 600, 250, 20][index],
        altMslFt: [1200, 900, 600, 250, 20][index],
      })
    );
    const landing = {
      runwayHdg: 90,
      runway: '09',
      runwayThreshold: { lat: 0, lon: 0 },
      touchdownDistance: {
        distanceFt: 1000,
        lateralOffsetFt: 0,
        lateralOffsetSide: 'center',
        lateralOffsetGrade: 'Good',
        runwayWidthFt: 150,
        runwayLengthFt: 8000,
      },
    };

    const fromLeftSvg = approachProfileApi.buildTopDownSvg(profile, {
      ...landing,
      windDirectionTrueDeg: 0,
      windSpeed: 14,
      crosswind: -14,
    });
    const fromLeftVector = findTopdownWindVector(fromLeftSvg);
    assert(fromLeftVector, 'wind from the runway left should render a vector group');
    assert.equal(Number(getSvgAttribute(fromLeftVector, 'data-wind-relative-deg')), -90, 'north wind on runway 09 should be 90 degrees left of the runway axis');
    assert.equal(Number(getSvgAttribute(fromLeftVector, 'data-wind-flow-relative-deg')), 90, 'wind from the left should flow toward the aircraft right');
    assert.equal(getSvgAttribute(fromLeftVector, 'data-wind-side'), 'left', 'negative runway-relative wind angle should identify the source as left');
    assert.match(getSvgAttribute(fromLeftVector, 'transform') || '', /rotate\(90(?:\.0+)?(?:[ ,)]|$)/, 'wind from the left should draw an airflow arrow pointing down');
    assert.match(fromLeftSvg, /WIND FROM (?:000|360)°T/, 'left-source vector should retain its true wind-from direction');
    assert.match(fromLeftSvg, /14 kt/, 'left-source vector should show touchdown wind speed');
    assertNoBadNumbers(fromLeftSvg, 'left-crosswind top-down SVG');

    const fromRightSvg = approachProfileApi.buildTopDownSvg(profile, {
      ...landing,
      windDirectionTrueDeg: 180,
      windSpeed: 14,
      crosswind: 14,
    });
    const fromRightVector = findTopdownWindVector(fromRightSvg);
    assert(fromRightVector, 'wind from the runway right should render a vector group');
    assert.equal(Number(getSvgAttribute(fromRightVector, 'data-wind-relative-deg')), 90, 'south wind on runway 09 should be 90 degrees right of the runway axis');
    assert.equal(Number(getSvgAttribute(fromRightVector, 'data-wind-flow-relative-deg')), -90, 'wind from the right should flow toward the aircraft left');
    assert.equal(getSvgAttribute(fromRightVector, 'data-wind-side'), 'right', 'positive runway-relative wind angle should identify the source as right');
    assert.match(getSvgAttribute(fromRightVector, 'transform') || '', /rotate\(-90(?:\.0+)?(?:[ ,)]|$)/, 'wind from the right should draw an airflow arrow pointing up');
    assert.match(fromRightSvg, /WIND FROM 180°T/, 'right-source vector should retain its true wind-from direction');
    assert.match(fromRightSvg, /14 kt/, 'right-source vector should show touchdown wind speed');
    assertNoBadNumbers(fromRightSvg, 'right-crosswind top-down SVG');

    const headwindSvg = approachProfileApi.buildTopDownSvg(profile, {
      ...landing,
      windDirectionTrueDeg: 90,
      windSpeed: 14,
      crosswind: 0,
    });
    const headwindVector = findTopdownWindVector(headwindSvg);
    assert.equal(Number(getSvgAttribute(headwindVector, 'data-wind-relative-deg')), 0, 'wind aligned with the runway heading should be sourced ahead');
    assert.equal(Number(getSvgAttribute(headwindVector, 'data-wind-flow-relative-deg')), -180, 'a headwind should draw airflow opposite the aircraft direction');
    assert.match(getSvgAttribute(headwindVector, 'transform') || '', /rotate\(-180(?:\.0+)?(?:[ ,)]|$)/, 'a headwind arrow should point left');

    const tailwindSvg = approachProfileApi.buildTopDownSvg(profile, {
      ...landing,
      windDirectionTrueDeg: 270,
      windSpeed: 14,
      crosswind: 0,
    });
    const tailwindVector = findTopdownWindVector(tailwindSvg);
    assert.equal(Number(getSvgAttribute(tailwindVector, 'data-wind-relative-deg')), -180, 'wind opposite the runway heading should be sourced behind');
    assert.equal(Number(getSvgAttribute(tailwindVector, 'data-wind-flow-relative-deg')), 0, 'a tailwind should draw airflow with the aircraft direction');
    assert.match(getSvgAttribute(tailwindVector, 'transform') || '', /rotate\(0(?:\.0+)?(?:[ ,)]|$)/, 'a tailwind arrow should point right');

    const arbitraryRunwaySvg = approachProfileApi.buildTopDownSvg(profile, {
      ...landing,
      runwayHdg: 248.8,
      runway: '24R',
      windDirectionTrueDeg: 340,
      windSpeed: 3,
      crosswind: 3,
    });
    const arbitraryRunwayVector = findTopdownWindVector(arbitraryRunwaySvg);
    assert.equal(Number(getSvgAttribute(arbitraryRunwayVector, 'data-wind-relative-deg')), 91.2, 'wind source should be rotated against the actual true runway heading');
    assert.equal(Number(getSvgAttribute(arbitraryRunwayVector, 'data-wind-flow-relative-deg')), -88.8, 'the arbitrary-heading airflow should point opposite its source');
    assert.equal(getSvgAttribute(arbitraryRunwayVector, 'data-wind-side'), 'right', '340 true on runway heading 248.8 true should remain a right crosswind');
    assert.match(getSvgAttribute(arbitraryRunwayVector, 'transform') || '', /rotate\(-88\.8(?:0+)?(?:[ ,)]|$)/, 'the reported right crosswind should draw an airflow arrow pointing upward');
    assertNoBadNumbers(arbitraryRunwaySvg, 'arbitrary-runway top-down SVG');
  });

  test('top-down wind vector suppresses calm, incomplete, and unsafe wind inputs', () => {
    const profile = [-6000, -4000, -2000, -500, 1000].map((alongFt, index) =>
      profilePoint({
        alongFt,
        crossFt: 0,
        raFt: [1200, 900, 600, 250, 20][index],
        altMslFt: [1200, 900, 600, 250, 20][index],
      })
    );
    const landing = {
      runwayHdg: 90,
      runway: '09',
      runwayThreshold: { lat: 0, lon: 0 },
      touchdownDistance: {
        distanceFt: 1000,
        runwayWidthFt: 150,
        runwayLengthFt: 8000,
      },
    };
    const suppressedInputs = [
      { label: 'missing wind', input: {} },
      { label: 'missing direction', input: { windSpeed: 14 } },
      { label: 'missing speed', input: { windDirectionTrueDeg: 0 } },
      { label: 'calm wind', input: { windDirectionTrueDeg: 0, windSpeed: 0.2, crosswind: 0 } },
      { label: 'negative speed', input: { windDirectionTrueDeg: 0, windSpeed: -14 } },
      { label: 'non-finite direction', input: { windDirectionTrueDeg: Infinity, windSpeed: 14 } },
      { label: 'non-finite speed', input: { windDirectionTrueDeg: 0, windSpeed: NaN } },
      {
        label: 'unsafe strings',
        input: {
          windDirectionTrueDeg: '0"><script>alert(1)</script>',
          windSpeed: '14"><image href=x onerror=alert(1)>',
        },
      },
    ];

    for (const { label, input } of suppressedInputs) {
      const svg = approachProfileApi.buildTopDownSvg(profile, { ...landing, ...input });
      assert.equal(findTopdownWindVector(svg), null, `${label} should not render a directional wind vector`);
      assert.doesNotMatch(svg, /<script|<image/i, `${label} should not inject executable SVG markup`);
      assert.doesNotMatch(svg, /alert\(1\)/i, `${label} should reject unsafe wind values instead of interpolating them`);
      assertNoBadNumbers(svg, `${label} top-down SVG`);
    }

    const withoutTrueRunwayHeading = { ...landing };
    delete withoutTrueRunwayHeading.runwayHdg;
    const designatorOnlySvg = approachProfileApi.buildTopDownSvg(profile, {
      ...withoutTrueRunwayHeading,
      windDirectionTrueDeg: 0,
      windSpeed: 14,
    });
    assert.equal(
      findTopdownWindVector(designatorOnlySvg),
      null,
      'true wind must not be rotated against a runway-designator-derived heading',
    );
  });

  test('top-down fallback renderer anchors touchdown offset without GPS', () => {
    const profile = [1200, 900, 600, 250, 20].map((raFt) => ({
      raFt,
      vsFpm: -650,
      iasKts: 135,
      gsKts: 135,
      dtMs: 5000,
      pitchDeg: 3,
      bankDeg: 0,
      headingDeg: 90,
    }));
    const svg = approachProfileApi.buildTopDownSvg(profile, {
      runwayHdg: 90,
      runway: '09',
      touchdownDistance: {
        distanceFt: 1000,
        lateralOffsetFt: 50,
        lateralOffsetSide: 'right',
        lateralOffsetGrade: 'Good',
        runwayWidthFt: 150,
        runwayLengthFt: 8000,
      },
    });

    assert.match(svg, /GPS pts: 0\/5/, 'should expose that GPS was unavailable');
    assert.match(svg, /THR: \(no runway threshold\)/, 'should expose missing threshold');
    assert.match(svg, /50 ft r/, 'fallback should still anchor touchdown offset label');
    assertNoBadNumbers(svg, 'top-down fallback SVG');
  });

  test('top-down renderer escapes runway diagnostics and sanitizes suffixes', () => {
    const profile = [-6000, -4000, -2000, -500, 1000].map((alongFt, index) =>
      profilePoint({
        alongFt,
        crossFt: -50,
        raFt: [1200, 900, 600, 250, 20][index],
        altMslFt: [1200, 900, 600, 250, 20][index],
      })
    );
    const svg = approachProfileApi.buildTopDownSvg(
      profile,
      {
        runwayHdg: 90,
        runway: '09"><img src=x onerror=alert(1)>',
        runwayThreshold: { lat: 0, lon: 0 },
        touchdownDistance: {
          distanceFt: 1000,
          lateralOffsetFt: 50,
          lateralOffsetSide: '<script>alert(1)</script>',
          lateralOffsetGrade: 'Good',
          runwayWidthFt: 150,
          runwayLengthFt: 8000,
          lateralOffsetSource: 'runway-geometry',
          lateralOffsetCalibration: {
            sampleCount: '<img src=x>',
            alongTrackFt: '<script>alert(1)</script>',
            rolloutRelativeOffsetFt: 5,
            rolloutRelativeOffsetSide: 'center',
            databaseOffsetFt: 75,
            databaseOffsetSide: '"><script>alert(1)</script>',
          },
        },
      },
      { idSuffix: '"><script>alert(1)</script>' }
    );

    assert.doesNotMatch(svg, /<script/i, 'should not emit raw script tags');
    assert.doesNotMatch(svg, /<img/i, 'should not emit raw image tags');
    assert.doesNotMatch(svg, /id="[^"]*[<>]/i, 'generated IDs should not contain raw tag characters');
    assert.match(svg, /RWY 09&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/, 'should render escaped runway text');
    assert.match(svg, /XT rollout-relative: 5 ft c \(&lt;img src=x&gt; pts, &lt;script&gt;alert\(1\)&lt;\/script&gt; ft\)/, 'should render escaped diagnostics');
    assertNoBadNumbers(svg, 'sanitized top-down SVG');
  });

  console.log('\nApproach profile renderer summary');
  if (failed > 0) {
    console.error(`${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
