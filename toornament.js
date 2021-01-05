'use strict';

const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const r = require("rethinkdbdash")({
    port: 28015,
    host: "localhost"
});

const config = require("./config.json");
const fs = require('fs')

const cookies = config.cookies;
const app = require('express')();
const opn = require('opn')
const cheerio = require('cheerio')
const api_key = config.toornament_api_key;

const riot_key = config.riot_key;
const port = 3003;
const callbackUrl = config.callbackUrl;
let token;
const { AuthorizationCode } = require('simple-oauth2');
const axios = require('axios');
const { range, lowerFirst } = require('lodash');

const client = new AuthorizationCode(config.oauth2);

// Authorization uri definition
const authorizationUri = client.authorizeURL({
    redirect_uri: callbackUrl,
    scope: 'organizer:view organizer:result',
    state: config.state,
}).replace("oauth", "oauth2");


// Initial page redirecting to Github
app.get('/auth', (req, res) => {
    console.log(authorizationUri);
    res.redirect(authorizationUri);
});
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let match_fails = [];
let already_done = [];
// Callback service parsing the authorization token and asking for the access token
app.get('/callback', async (req, res) => {
    const { code } = req.query;
    const options = {
        code,
        redirect_uri: callbackUrl
    };
    console.log("code: " + code);
    try {
        const accessToken = await client.getToken(options);
        token = accessToken.token.access_token;
        console.log('The resulting token: ', accessToken.token);

        return res.status(200).json(accessToken.token);
    } catch (error) {
        console.error('Access Token Error', error);
        return res.status(500).json('Authentication failed');
    }
});

app.get('/', (req, res) => {
    res.redirect('/auth')
});


app.listen(port, (err) => {
    if (err) return console.error(err);

    console.log(`Express server listening at http://localhost:${port}`);
});


async function getTournamentInfo(tournamentId) {
    const config = {
        method: 'get',
        url: 'https://api.toornament.com/organizer/v2/tournaments/' + tournamentId,
        headers: { 'X-Api-Key': api_key, 'Authorization': 'Bearer ' + token }
    }

    try {
        const response = await axios(config);

        return response.data
    } catch (e) {
	
        console.log("Wrong permissions.", e, response);
        return;
    }
}

async function getMatches(tournamentId) {
    let array = [];
    let array_max = 1;
    let i = 0;


    //return new Promise((resolve,reject) => {})
    while (i < array_max) {
        try {
            const config = {
                method: 'get',
                url: 'https://api.toornament.com/organizer/v2/tournaments/' + tournamentId + '/matches',
                headers: { 'X-Api-Key': api_key, 'Authorization': 'Bearer ' + token, 'Range': `matches=${i}-${i + 99}` }
            }
            const response = await axios(config);
            for (let match of response.data) {
                if (already_done.includes(match.id))
                    continue;
                if (match.status != 'completed')
                    continue;
                const config_games = {
                    method: 'get',
                    url: `https://api.toornament.com/organizer/v2/tournaments/${tournamentId}/matches/${match.id}/games`,
                    headers: { 'X-Api-Key': api_key, 'Authorization': 'Bearer ' + token, 'Range': `games=0-49` }
                }
                const response_games = await axios(config_games);
                match.games = response_games.data;
                array.push(match);
            }
            array_max = parseInt(response.headers['content-range'].split('/')[1]);
            i += 100;
        } catch (e) {
            match_fails.push(tournamentId);
            console.log("Wrong permissions.", e);
        }
    }
    return array;
}


//  |ilililiili|   |-----------|                       /\_____/\
// {|-[]----[]-|} /| BRAQUAGE  |                      /         \
//  |    \/    | / |-----------|                     |  ^    ^  |
//  |__________|                                     \   >-<   /
//     ||        '/,====                              \       |
//      ---------/                                     (      \____   |
//                                                     |           \  |
//                                                     | | |(      | /
//                                                     | | ||\     |/
//                                                    c_/c/c_c\___/
//
//
//
async function parse_web(match, tournamentId) {
    if (match.status != 'completed')
        return;

    const code_page = await axios.get(`https://organizer.toornament.com/tournaments/${tournamentId}/matches/${match.id}/tournament-code`, cookies);
    let $ = cheerio.load(code_page.data);
    match.codes = $(".button-clipboard").toArray().map((element) => { return element.attribs["data-clipboard-text"] });

    const link_page = await axios.get(`https://organizer.toornament.com/tournaments/${tournamentId}/matches/${match.id}/league-of-legends-stats`, cookies);
    $ = cheerio.load(link_page.data);
    match.links = $("[id^='match_set_status_collection_statuses']").toArray().map((element) => { return element.attribs.value });

}


async function riot_call(match) {
    match.data = [];
    for (let i in range(match.links.length)) {
        if (!match.links[i]) {
            match.data.push(null);
            match.links[i] = null;
            continue;
        }
        let matchId = match.links[i].split('/')[6];
        try {
	    let res = await axios.get(`https://euw1.api.riotgames.com/lol/match/v4/matches/${matchId}/by-tournament-code/${match.codes[i]}?api_key=${riot_key}`);
            match.data.push(res.data);
        } catch (error) {
            match.data.push(null);
        }
    }
}
let ranks = {};
async function get_rank(summonerId) {
    if (ranks[summonerId])
        return ranks[summonerId]
    await sleep(30);
    let res = await axios.get(`https://euw1.api.riotgames.com/lol/league/v4/entries/by-summoner/${summonerId}?api_key=${riot_key}`);
    let solo = res.data.filter(q => q.queueType == 'RANKED_SOLO_5x5');
    if (solo.length != 0) {
        ranks[summonerId] = solo[0].tier + ' ' + solo[0].rank;
        return solo[0].tier + ' ' + solo[0].rank;
    }
    ranks[summonerId] = "";
    return "";
}


async function add_team_info(opponent, player) {
    await r.db('GL5').table('teams').filter({ name: opponent.name }).run().then(async (response) => {
        if (response.length == 0) {
            opponent.profileIcon = player.profileIcon;
            opponent.players = [player];
            r.db('GL5').table('teams').insert(opponent).run();
        } else {
            if (response[0].players.filter((p) => p.accountId == player.accountId).length != 0) {
                response[0].players.filter((p) => p.accountId == player.accountId)[0].summonerName = player.summonerName;
                response[0].players.filter((p) => p.accountId == player.accountId)[0].soloRank = player.soloRank;
                response[0].players.filter((p) => p.accountId == player.accountId)[0].profileIcon = player.profileIcon;
            } else
                response[0].players.push(player)
            await r.db('GL5').table('teams').filter({ name: opponent.name }).update({ players: response[0].players }).run();
        }
    });
}

async function add_player_info(identity, player_perf, match, i) {
    await r.db('GL5').table('playersFiltered').filter({ accountId: identity.accountId }).run().then(async (response) => {
        if (response.length == 0) {
            identity.region = match.tournament_name.split('-')[1].trim();
            identity.palier = match.tournament_name.split('-')[2].trim();
            identity.summonerName = identity.summonerName.trim();
            let n = 0;

            if (player_perf.stats.win)
                n = match.games[i].opponents.filter(op => op.result == 'win')[0].number;
            else
                n = match.games[i].opponents.filter(op => op.result != 'win')[0].number;
            identity.participant = match.opponents.filter(op => op.number == n)[0].participant;
            identity.participant.region = identity.region;
            identity.soloRank = await get_rank(identity.summonerId);
            identity.participant.palier = identity.palier;
            identity.games = [player_perf];
            r.db('GL5').table('playersFiltered').insert(identity).run();
            await add_team_info(identity.participant, { summonerName: identity.summonerName, accountId: identity.accountId, profileIcon: identity.profileIcon, soloRank: identity.soloRank })
        } else {
	//if(identity.summonerName != response[0].summonerName)
//	    console.log(response[0].games[0].gameId, player_perf.gameId);//.filter((game) => game.gameId == match.gameId));
            if (response[0].games.filter((game) => game.gameId == player_perf.gameId).length != 0){
            	console.log("Game already in player's info.");
		    return;
	    }
            response[0].games.push(player_perf)
            await r.db('GL5').table('playersFiltered').filter({ accountId: identity.accountId }).update({
                profileIcon: identity.profileIcon,
                games: response[0].games,
	        summonerName: identity.summonerName,
                soloRank: await get_rank(identity.summonerId)
            }).run();

	    await add_team_info(identity.participant, { summonerName: identity.summonerName, accountId: identity.accountId, profileIcon: identity.profileIcon, soloRank: identity.soloRank })
        }
    });
}

async function filter_all_games() {
    let i = 1;

    r.db('GL5').table('matches').run().then(async (response) => {
        for (let match of response) {
            for (let l = 0; l < match.data.length; l++) {
                let data = match.data[l];
                if (data === null)
                    continue;
                for (let i = 0; i < data.participantIdentities.length; i++) {
                    let identity = data.participantIdentities[i];
                    let player_perf = data.participants[i];
                    player_perf.gameId = data.gameId;
                    player_perf.gameCreation = data.gameCreation;
                    await add_player_info(identity.player, player_perf, match, l);
                }
            }
            console.log("Filtered match " + i + "/" + response.length);
            i++;
        }
    });
}

async function filter_games(matches) {
    if (matches.length == 0) {
        console.log("No new matches to filter.");
        return;
    }
    let i = 1;
    for (let match of matches) {
        for (let l = 0; l < match.data.length; l++) {
            let data = match.data[l];
            if (data === null)
                continue;
            for (let i = 0; i < data.participantIdentities.length; i++) {
                let identity = data.participantIdentities[i];
                let player_perf = data.participants[i];
                player_perf.gameId = data.gameId;
                player_perf.gameCreation = data.gameCreation;
                await add_player_info(identity.player, player_perf, match, l);
            }
        }
        console.log("Filtered match " + i + "/" + matches.length);
        i++;
    }
}

async function update_done_matches() {
    already_done = []
    await r.db('GL5').table('matches').run().then(response => {
        response.forEach(match => {
            already_done.push(match.id);
        });
        console.log(response.length, "matches are in the database.");
    });
}

async function parseTournament(t, log) {
    match_fails = match_fails.filter(m => m != t);
    let t_info = await getTournamentInfo(t);
    let matches = await getMatches(t); //input.split(' ')[1]);
    console.log(matches.length);
    matches = matches.filter((match) => match.status == 'completed');
    console.log(matches.length);
    console.log("Found", matches.length, "completed matches for tournament", t, ".");
    let i = 0;
    for (let match of matches) {
        i++;

        match.tournament_name = t_info.name;
        match.tournament_id = t_info.id;
        match.tournament_full_name = t_info.full_name;
        if (match.status == 'completed') {
            await parse_web(match, t);

            await riot_call(match);
            await r.db('GL5').table('matches').insert(match).run();
        }
        console.log(log + "Match " + i + "/" + matches.length);
    }
    await filter_games(matches);
}

async function inspect() {
    let coach = [];
    let gt6 = [];
    await r.db('GL5').table('teams').run().then(response => {
        response.forEach(team => {
            if (team.players.filter(p => p.summonerName == team.custom_fields.coach).length != 0)
                coach.push(team);
            if (team.players.length > 5)
                gt6.push(team)
        });
    });
    let content = "";
    content += 'Coach played\n';
    coach.forEach(team => {
        content += `${team.name},${team.region},${team.palier},Coach,${team.custom_fields.coach},Players,${team.players.map(p => { return p.summonerName }).join(",")}\n`;
    });
    content += '\nMore than 5 players\n';
    gt6.forEach(team => {
        content += `${team.name},${team.region},${team.palier},Players,${team.players.map(p => { return p.summonerName }).join(",")}\n`;
    });
    fs.writeFile('inspection.csv', content, function () { });
    console.log("Inspection done, check inspection.txt");
}


async function generate_statistics() {
	console.log("euh2");
    let stats = {
        totalKills: 0,
        totalCS: 0,
        totalGames: 0,
        totalDamages: 0,
        totalGoldSpent: 0,
        kda: {
            value: 0,
            summonerName: ""
        },
        cs: {
            value: 0,
            summonerName: ""
        },
        visionScore: {
            value: 0,
            summonerName: ""
        },
        alive: {
            value: 0,
            summonerName: ""
        },
        damages: {
            value: 0,
            summonerName: ""
        },
        pentakills: {
            players: []
        }
    };
    let champions = {};
    await r.db('GL5').table('playersFiltered').run().then(response => {
		console.log("euh3");

        for (let player of response) {
            let kills = 0;
            let deaths = 0;
            let assists = 0;
            let kda = 0;
            let visionScore = 0;
            let cs = 0;
            let damages = 0;
            for (let game of player.games) {
                if (champions[game.championId] === undefined) {
                    champions[game.championId] = 0;
                }
                else
                    champions[game.championId] += 1;

                if (game.stats.largestMultiKill == 5) {
		    console.log({ summonerName: player.summonerName, profileIcon: player.profileIcon });
                    stats.pentakills.players.push({ summonerName: player.summonerName, profileIcon: player.profileIcon });
                }
                stats.totalGoldSpent += game.stats.goldSpent;
                stats.totalKills += game.stats.kills;
                stats.totalCS += game.stats.totalMinionsKilled + game.stats.neutralMinionsKilled;
                stats.totalDamages += game.stats.totalDamageDealtToChampions;
                cs += game.stats.totalMinionsKilled + game.stats.neutralMinionsKilled;
                kills += game.stats.kills;
                deaths += game.stats.deaths;
                assists += game.stats.assists;
                visionScore += game.stats.visionScore;
                if (game.stats.longestTimeSpentLiving > stats.alive.value) {
                    stats.alive.value = game.stats.longestTimeSpentLiving;
                    stats.alive.summonerName = player.summonerName;
                    stats.alive.profileIcon = player.profileIcon;
                }
                damages += game.stats.totalDamageDealtToChampions;
                kda += (game.stats.kills + game.stats.assists) / (game.stats.deaths == 0 ? 1 : game.stats.deaths);
            }
            kda /= player.games.length;
            if (kda > stats.kda.value && player.games.length > 2) {
                stats.kda.value = kda;
                stats.kda.kills = kills / player.games.length;
                stats.kda.deaths = deaths / player.games.length;
                stats.kda.assists = assists / player.games.length;
                stats.kda.summonerName = player.summonerName;
                stats.kda.profileIcon = player.profileIcon;
            }
            visionScore /= player.games.length;
            if (visionScore > stats.visionScore.value && player.games.length > 2) {
                stats.visionScore.value = visionScore;
                stats.visionScore.summonerName = player.summonerName;
                stats.visionScore.profileIcon = player.profileIcon;
            }
            cs /= player.games.length;
            if (cs > stats.cs.value && player.games.length > 2) {
                stats.cs.value = cs;
                stats.cs.summonerName = player.summonerName;
                stats.cs.profileIcon = player.profileIcon;
            }
            damages /= player.games.length;
            if (damages > stats.damages.value && player.games.length > 2) {
                stats.damages.value = damages;
                stats.damages.summonerName = player.summonerName;
                stats.damages.profileIcon = player.profileIcon;
            }
        }
        let max = 0;
        let champMax = 0;
        for (let key in champions) {
            if (champions[key] > max) {
                max = champions[key];
                champMax = key;
            }
        }
	console.log(stats.pentakills.players.length);
        stats.popChampion = { id: champMax, value: max };

    });
	let zz = 0;
    await r.db('GL5').table('matches').run().then(response => {
       	console.log(response.length);
	 for (let match of response){
            for (let game of match.data){
            	zz++;
			if (game){

                    stats.totalGames += 1;
	        }
	    }
	}
    });
	console.log(zz);
    await r.db('GL5').table('statistics').delete().run();
    await r.db('GL5').table('statistics').insert(stats).run();
}


rl.on('line', async (input) => {
    if (input === "open") {
        opn("http://localhost:3003", { app: 'chrome' });
    } else if (input == 'filter') {
        await r.db('GL5').table('playersFiltered').delete().run();
        await r.db('GL5').table('teams').delete().run();
        filter_all_games();
    } else if (input.startsWith("t")) {
        await update_done_matches();

        let tournaments = config.tournamentIds;
        let z = 1;
        for (let t of tournaments) {
            await parseTournament(t, z + " ")
            console.log("Finished tournament " + z + "/" + tournaments.length);
            z++;
        }
        console.log("Waiting for the " + match_fails.length + " fails...");
        await update_done_matches();
        while (match_fails.length != 0) {
            for (let c = 0; c < match_fails.length; c++)
                await parseTournament(match_fails[c], "f" + c)
        }
    } else if (input.startsWith("delete")) {
        await r.db('GL5').table('matches').delete().run();
        await r.db('GL5').table('playersFiltered').delete().run();
        await r.db('GL5').table('teams').delete().run();
        console.log("Reset done.");
    } else if (input.startsWith("inspect")) {
        inspect();

    } else if (input.startsWith("stats")) {
	console.log("euh");
        await generate_statistics();
        console.log("Statistics generated.");
    }
});

/*
r.db('GL5').table("matches").run().then(response => {
    for (let match of response) {
        if (match.opponents.filter(op => op.participant.name == "Les fiers de haches").length != 0) {
            console.log(match);
            fs.appendFile('seek.json', JSON.stringify(match, null, 4), function(){});


        }
    }
});
*/
