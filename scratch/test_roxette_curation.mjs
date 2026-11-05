import collaborativeGraph from '../src/services/collaborativeGraph.js';
import deezer from '../src/services/deezer.js';

async function test() {
  console.log('Testing Roxette related artists...');
  const related = await collaborativeGraph.getRelatedArtists('Roxette', 15);
  console.log('Related:', related);

  if (related.length > 0) {
    const candidateArtistNames = related.map(r => r.name);
    console.log('Candidate names:', candidateArtistNames);
    const deepCuts = await collaborativeGraph.getDeepCutsForArtists(candidateArtistNames.slice(0, 8), 5, 2);
    console.log('Deep cuts count:', deepCuts.length);
    console.log('Sample deep cuts:', deepCuts.slice(0, 5).map(t => `${t.artist} - ${t.title}`));
  }
}

test().catch(console.error);
