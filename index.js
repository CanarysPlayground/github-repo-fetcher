const axios = require('axios');
const fs = require('fs');
const { createObjectCsvWriter } = require('csv-writer');

// Sleep function to wait when rate limit is hit
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// API call with retry on rate limit
const apiCallWithRetry = async (url, pat, params = {}) => {
  while (true) {
    try {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${pat}` },
        params,
      });
      return response;
    } catch (error) {
      if (error.response && error.response.status === 403) {
        const resetTime = error.response.headers['x-ratelimit-reset'];
        const currentTime = Math.floor(Date.now() / 1000);
        const waitTime = resetTime - currentTime;
        console.warn(`⚠️ Rate limit hit. Waiting for ${waitTime} seconds...`);
        await sleep(waitTime * 1000);
      } else {
        console.error(`❌ Error: ${error.message}`);
        return null;
      }
    }
  }
};

// Fetch repository data with pagination
const fetchRepoData = async (orgName, pat, perPage) => {
  let page = 1;
  let repoData = [];

  while (true) {
    const response = await apiCallWithRetry(
      `https://api.github.com/orgs/${orgName}/repos`,
      pat,
      { per_page: perPage, page }
    );
    if (!response || !response.data.length) break;

    repoData.push(...response.data);

    if (!response.headers.link || !response.headers.link.includes('rel="next"')) break;
    page++;
  }

  return repoData;
};

// Fetch last pushed date across all branches
const getLastPushedDate = async (orgName, repoName, pat) => {
  let lastPushedDate = null;

  const branchesResponse = await apiCallWithRetry(
    `https://api.github.com/repos/${orgName}/${repoName}/branches`,
    pat
  );

  if (!branchesResponse) return "N/A";

  const branches = branchesResponse.data;

  for (const branch of branches) {
    const branchDetails = await apiCallWithRetry(
      `https://api.github.com/repos/${orgName}/${repoName}/commits`,
      pat,
      { sha: branch.name, per_page: 1 }
    );

    if (branchDetails && branchDetails.data.length > 0) {
      const commitDate = new Date(branchDetails.data[0].commit.committer.date);
      if (!lastPushedDate || commitDate > lastPushedDate) {
        lastPushedDate = commitDate;
      }
    }
  }

  return lastPushedDate ? lastPushedDate.toISOString() : "N/A";
};

// Get repository details including last pushed, created, and updated dates
const getRepoDetails = async (repo, orgName, pat) => {
  const repoName = repo.name;
  const apiUrl = `https://api.github.com/repos/${orgName}/${repoName}`;

  try {
    const [tagsRes, releasesRes] = await Promise.all([
      apiCallWithRetry(`${apiUrl}/tags`, pat),
      apiCallWithRetry(`${apiUrl}/releases`, pat),
    ]);

    const lastPushedDate = await getLastPushedDate(orgName, repoName, pat);

    return {
      repoName: repo.name,
      visibility: repo.visibility,
      sizeMB: (repo.size / 1024).toFixed(2),
      createdDate: repo.created_at,
      updatedDate: repo.updated_at,
      lastPushedDate: lastPushedDate,
      totalBranches: repo.default_branch ? 1 : "N/A",
      totalCommits: repo.commits || "N/A",
      openIssues: repo.open_issues_count || 0,
      totalTags: tagsRes ? tagsRes.data.length : "N/A",
      totalReleases: releasesRes ? releasesRes.data.length : "N/A",
    };
  } catch (error) {
    console.error(`❌ Error fetching details for repo: ${repoName} - ${error.message}`);
    return {
      repoName: repo.name,
      visibility: repo.visibility,
      sizeMB: (repo.size / 1024).toFixed(2),
      createdDate: "N/A",
      updatedDate: "N/A",
      lastPushedDate: "N/A",
      totalBranches: "N/A",
      totalCommits: "N/A",
      openIssues: "N/A",
      totalTags: "N/A",
      totalReleases: "N/A",
    };
  }
};

// Write CSV data
const writeCsv = (orgName, repoDetails) => {
  const timestamp = new Date().toISOString().replace(/[:.-]/g, '_');
  const csvWriter = createObjectCsvWriter({
    path: `${orgName}_repo_details_${timestamp}.csv`,
    header: [
      { id: 'repoName', title: 'Repository Name' },
      { id: 'visibility', title: 'Visibility' },
      { id: 'sizeMB', title: 'Size (MB)' },
      { id: 'createdDate', title: 'Created Date' },
      { id: 'updatedDate', title: 'Updated Date' },
      { id: 'lastPushedDate', title: 'Last Pushed Date' },
      { id: 'totalBranches', title: 'Total Branches' },
      { id: 'totalCommits', title: 'Total Commits' },
      { id: 'openIssues', title: 'Open Issues' },
      { id: 'totalTags', title: 'Total Tags' },
      { id: 'totalReleases', title: 'Total Releases' },
    ],
  });

  csvWriter
    .writeRecords(repoDetails)
    .then(() => console.log(`✅ CSV for ${orgName} generated successfully!`))
    .catch(err => console.error(`❌ Error writing CSV: ${err}`));
};

// Main function
(async () => {
  console.log('🔍 Debug: Environment variables passed to the action:');
  console.log(`INPUT_ORGS: ${process.env.INPUT_ORGS || 'Not provided'}`);
  console.log(`INPUT_PAT: ${process.env.INPUT_PAT ? '*****' : 'Not provided'}`);

  const orgNamesInput = process.env.INPUT_ORGS || '';
  const pat = process.env.INPUT_PAT;
  const perPage = parseInt(process.env.INPUT_PER_PAGE) || 100;

  if (!orgNamesInput) {
    console.error('❌ Error: INPUT_ORGS is missing. Please provide organization names.');
    process.exit(1);
  }

  if (!pat) {
    console.error('❌ Error: INPUT_PAT (Personal Access Token) is missing.');
    process.exit(1);
  }

  const orgNames = orgNamesInput.split(',').map((org) => org.trim());
  console.log(`📦 Orgs to fetch: ${orgNames}`);

  let summary = '';

  for (const orgName of orgNames) {
    console.log(`🔄 Fetching details for ${orgName}...`);
    const repoData = await fetchRepoData(orgName, pat, perPage);

    if (repoData) {
      const repoDetailsPromises = repoData.map((repo) => getRepoDetails(repo, orgName, pat));
      const repoDetails = await Promise.all(repoDetailsPromises);

      writeCsv(orgName, repoDetails);
      summary += `Org: ${orgName} | Total Repositories: ${repoData.length}\n`;
    }
  }

  console.log('🚀 Summary:');
  console.log(summary);
})();
