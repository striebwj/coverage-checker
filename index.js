const core = require('@actions/core');
const github = require('@actions/github');
const glob = require('@actions/glob');
const {exec} = require('child_process');
const fs = require('fs');
const fetch = require('node-fetch');
const process = require('process');
const convert = require('xml-js');

const ACTION = core.getInput('action');
const COVERAGE_BRANCH = 'coverage';
const COVERAGE_FILES = JSON.parse(core.getInput('files'));
const TOKEN = core.getInput('token');
const REPO = `https://${process.env.GITHUB_ACTOR}:${TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
const HISTORY_FILENAME = 'coverage-history.json';
const REPORT_MESSAGE_HEADER = 'Issued by Coverage Checker:';

const fail = (message) => {
    core.setFailed(message);
    console.error(message);
    process.exit(-1);
};

const execute = (command, options) => new Promise(function (resolve, reject) {
    const cb = (error, stdout, stderr) => {
        if (error) {
            core.setFailed(error);
            reject(error);

            return;
        }

        resolve(stdout.trim());
    };

    if (!!options) {
        exec(command, options, cb);
    } else {
        exec(command, cb);
    }
});

const findNode = (tree, name) => {
    if (!tree.elements) {
        fail('Wrong coverage file format');
    }

    const element = tree.elements.find(e => e.name === name);

    if (!element) {
        fail('Wrong coverage file format');
    }

    return element;
}

const retrieveGlobalMetricsElement = json => findNode(findNode(findNode(json, 'coverage'), 'project'), 'metrics');

const clone = async () => {
    const cloneInto = `repo-${new Date().getTime()}`;

    console.log(`Cloning repository in ${cloneInto}`);
    await execute(`git clone ${REPO} ${cloneInto}`);

    console.log(`Retrieving existing branches`);
    const list = await execute(`git branch -a`, {cwd: cloneInto});
    const branches = list.split('\n').filter(b => b.length > 2).map(b => b.replace('remotes/origin/', '').trim());

    if (branches.includes(COVERAGE_BRANCH)) {
        console.log(`Coverage branch exists. Checking it out.`);
        await execute(`git checkout ${COVERAGE_BRANCH}`, {cwd: cloneInto});
        await execute(`git pull`, {cwd: cloneInto});
    } else {
        console.log(`Coverage branch does not exist. Creating it.`);
        await execute(`git checkout --orphan ${COVERAGE_BRANCH}`, {cwd: cloneInto});
        await execute(`rm -rf .`, {cwd: cloneInto});
    }

    return cloneInto;
};

const push = async (cwd) => {
    await execute('git config --local user.email zozor@openclassrooms.com', {cwd});
    await execute('git config --local user.name Zozor', {cwd});
    await execute('git add .', {cwd});
    await execute('git commit -m "Update coverage info" --allow-empty', {cwd});
    await execute(`git push ${REPO} HEAD`, {cwd});
};

const parseCoverage = async file => {
    const globber = await glob.create(file);
    const files = await globber.glob();

    if (files.length === 0) {
        fail('Coverage file not found :/');
    }

    const options = {ignoreComment: true, alwaysChildren: true};
    const json = convert.xml2js(fs.readFileSync(files[0], {encoding: 'utf8'}), options);
    const metrics = retrieveGlobalMetricsElement(json);
    const total = parseInt(metrics.attributes.elements, 10);
    const covered = parseInt(metrics.attributes.coveredelements, 10);
    const coverage = parseFloat((100 * covered / total).toFixed(3));

    console.log('Metrics gathered from clover file:', metrics.attributes);

    return { total, covered, coverage };
}

const parseCoverages = async () => {
    const reports = {};

    for (const file of COVERAGE_FILES) {
        console.log(`Parsing ${file.coverage}...`);
        reports[file.summary] = await parseCoverage(file.coverage);
        console.log(`Parsed ${file.coverage}`);
    }

    return reports;
};

const fetchBaseCoverage = summaryFile => fetch(`https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/${COVERAGE_BRANCH}/${summaryFile}`, {
    headers: {
        'Authorization': `token ${TOKEN}`,
        'Accept': 'application/vnd.github.v3.raw'
    }
});

const fetchHistory = () => fetch(`https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/${COVERAGE_BRANCH}/${HISTORY_FILENAME}`, {
    headers: {
        'Authorization': `token ${TOKEN}`,
        'Accept': 'application/vnd.github.v3.raw'
    }
});

const sumCoverages = coverages => {
    const out = {
        total: 0,
        covered: 0
    };

    for (const coverage of Object.values(coverages)) {
        out.total += coverage.total;
        out.covered += coverage.covered;
    }

    out.coverage = parseFloat((100 * out.covered / out.total).toFixed(3));

    return out;
}

const getBadgeUrl = (coverage, label) => `https://img.shields.io/static/v1?label=${encodeURIComponent(label)}&message=${encodeURIComponent(coverage)}%25&color=${processBadgeColor(coverage)}&style=for-the-badge`;

const processBadgeColor = coverage => {
    const colors = [
        { threshold: 50, color: 'red' },
        { threshold: 75, color: 'orange' },
        { threshold: 95, color: 'yellow' }
    ];

    for (let i = 0 ; i < colors.length ; i++) {
        if (coverage < colors[i].threshold) {
            return colors[i].color;
        }
    }

    return 'green';
}

const postMessageOnPullRequest = async message => {
    const context = github.context;

    console.log(message);

    if (context.payload.pull_request == null) {
        return;
    }

    const body = REPORT_MESSAGE_HEADER + '\n\n' + message;

    const pullRequestNumber = context.payload.pull_request.number;
    const octokit = new github.getOctokit(TOKEN);

    const commentId = await retrieveCommentIdFromPullRequest(context, octokit);

    if (commentId !== null) {
        await octokit.issues.updateComment({
           ...context.repo,
           body,
           comment_id: commentId
        });
    } else {
        await octokit.issues.createComment({
           ...context.repo,
           body,
           issue_number: pullRequestNumber
        });
    }
};

const retrieveCommentIdFromPullRequest = async (context, octokit) => {
    const pullRequestNumber = context.payload.pull_request.number;

    const { data: comments } = await octokit.issues.listComments({
       ...context.repo,
       issue_number: pullRequestNumber
    });
    const comment = comments.find(comment => comment.user.login === 'github-actions[bot]' && comment.body.startsWith(REPORT_MESSAGE_HEADER));

    return comment ? comment.id : null;
};

const buildDeltaMessage = (oldCoverage, newCoverage) => {
    return [
        '',
        '| Measure | Main branch | ' + process.env.GITHUB_REF + ' |',
        '| --- | --- | --- |',
        '| Coverage | ' + oldCoverage.coverage + '% | ' + newCoverage.coverage + '% |',
        '| Total lines | ' + oldCoverage.total + ' | ' + newCoverage.total + ' |',
        '| Covered lines | ' + oldCoverage.covered + ' | ' + newCoverage.covered + ' |',
        '',
        '∆ ' + (newCoverage.coverage - oldCoverage.coverage).toFixed(3),
        ''
    ].join('\n');
}

const buildFailureMessage = (oldCoverage, newCoverage) => {
    return ':x: Your code coverage has been degraded :sob:' + buildDeltaMessage(oldCoverage, newCoverage);
};

const buildSuccessMessage = (oldCoverage, newCoverage) => {
    return ':white_check_mark: Your code coverage has not been degraded :tada:' + buildDeltaMessage(oldCoverage, newCoverage);
};

const buildResultMessage = (oldCoverage, newCoverage) => {
    if (newCoverage.coverage < oldCoverage.coverage) {
        core.setFailed('Code coverage has been degraded');

        return buildFailureMessage(oldCoverage, newCoverage);
    }

    return buildSuccessMessage(oldCoverage, newCoverage);
}

const update = async coverages => {
    console.log('Updating base coverage...');
    const workingDir = await clone();
    const historyFile = await fetchHistory();
    const history = historyFile.status === 200 ? (await historyFile.json()) : {};

    for (const summaryFile of Object.keys(coverages)) {
        const conf = COVERAGE_FILES.find(e => e.summary === summaryFile);

        console.log(`Writing ${summaryFile} report (${workingDir}/${summaryFile})`);
        fs.writeFileSync(`${workingDir}/${summaryFile}`, JSON.stringify(coverages[summaryFile]));

        if (conf.badge) {
            const badgeContent = await fetch(getBadgeUrl(coverages[summaryFile].coverage, conf.label));

            fs.writeFileSync(`${workingDir}/${conf.badge}`, await badgeContent.text());
        }

        if (typeof history[conf.label] === 'undefined') {
            history[conf.label] = [];
        }

        history[conf.label].push({
            time: (new Date()).toISOString(),
            coverage: coverages[summaryFile].coverage
        });
    }
    fs.writeFileSync(`${workingDir}/${HISTORY_FILENAME}`, JSON.stringify(history));

    console.log('Pushing to coverage branch');
    await push(workingDir);

    console.log('Coverage successfully updated');
};

const check = async coverages => {
    const baseCoverages = {};
    const messages = [];

    for (const summaryFile of Object.keys(coverages)) {
        const baseCoverageResult = await fetchBaseCoverage(summaryFile);
        const coverage = coverages[summaryFile];

        if (baseCoverageResult.status === 404) {
            console.log(`No base coverage ${summaryFile} found. Current coverage is ${coverage.coverage}% (${coverage.total} lines, ${coverage.covered} covered)`);
            continue;
        }

        baseCoverages[summaryFile] = await baseCoverageResult.json();

        messages.push('*' + COVERAGE_FILES.find(e => e.summary === summaryFile).label + '* \n\n' + buildResultMessage(baseCoverages[summaryFile], coverage));
    }

    if (Object.keys(coverages).length > 1) {
        const globalBaseCoverage = sumCoverages(baseCoverages);
        const globalCoverage = sumCoverages(coverages);

        messages.push('*Global* \n\n' + buildResultMessage(globalBaseCoverage, globalCoverage));
    }

    await postMessageOnPullRequest(messages.join('\n---\n'));
};

const action = async () => {
    try {
        console.log('Parsing clover files...')
        const coverages = await parseCoverages();

        await (ACTION === 'update' ? update(coverages) : check(coverages));
    } catch (error) {
        core.setFailed(error.message);
    }
};

action();
