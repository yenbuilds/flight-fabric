const profileLoader = require('../aircraft/aircraft-profile-loader.js') as {
  getLandingGrades: () => LandingGradeThresholds | null;
};
type LandingGradeThresholds = {
  perfectMinFpm: number;
  goodMinFpm: number;
  firmMinFpm: number;
  hardMinFpm: number;
};

type LandingGrade = {
  grade: 'PERFECT' | 'GOOD' | 'FIRM' | 'HARD' | 'VERY HARD';
  color: 'lime' | 'deepskyblue' | 'gold' | 'orange' | 'red';
};

const FALLBACK_GRADES: LandingGradeThresholds = {
  perfectMinFpm: -250,
  goodMinFpm: -450,
  firmMinFpm: -700,
  hardMinFpm: -1000,
};

function gradeLanding(vs: number): LandingGrade {
  if (!Number.isFinite(vs)) {
    return { grade: 'FIRM', color: 'gold' };
  }

  const profileGrades = profileLoader.getLandingGrades();
  const grades = profileGrades || FALLBACK_GRADES;

  if (vs > grades.perfectMinFpm) return { grade: 'PERFECT', color: 'lime' };
  if (vs > grades.goodMinFpm) return { grade: 'GOOD', color: 'deepskyblue' };
  if (vs > grades.firmMinFpm) return { grade: 'FIRM', color: 'gold' };
  if (vs > grades.hardMinFpm) return { grade: 'HARD', color: 'orange' };
  return { grade: 'VERY HARD', color: 'red' };
}

const landingApi = {
  gradeLanding,
};

module.exports = landingApi;

export {};
