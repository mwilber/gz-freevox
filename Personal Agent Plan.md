# High Level Architecture

Product names in parenthesis are tentative but must be decided before production starts.

## Back End

### Agent (SELMA) headless

Nodejs app running on heroku. Local tool set to create todo list and mark items as complete. Very simple, list is local array of objects with description and complete status. Additional tools provided by MCP client connected to an unlimited number of remote hosted web servers. Single entry point sends transcript of conversation. Transcript can be any length, 1 word to 100 pages. Transcript is immediately sent to data store to archive. Transcript continues into Agent loop. Agent begins by reading transcript, uses todo list tool to create a list of items to be accomplished with MCP tool calls. Agent continues to loop through local todo items, for each item, an MCP tool is called. when the MCP tool succeeds, the local tool to mark item complete is called. Loop continues until Agent determines all items are complete. Each successful tool call name and parameters are recorded. When agent loop ends, recorded tool calls are sent to data store to attach to transcript record.

MCP server connections

- Remember The Milk (personal To Do list service)

Possible Considerations

- A way of notifying phone when agent loop completes. Summary of all actions.

### Data Store (SID) 

Built on existing LAMP server. This means MySQL and php are non-negotiable. No third party packages or libraries unless explicitly specified. Software integration will be done through a simple REST API so this shouldn’t ever be an issue. REST endpoints add, list, search. Priority is add endpoint. Before agent is triggered, conversation is added and unique id is returned. Everything added is timestamped here. Nice to have, ability to attach agent tool calls generated from run as separate api end point. Safe to assume just one agent run after create, no follow ups. Create web UI to browse all records. This is a simple listing with ability to click on item to see full transcript. Markdown in transcript will be formatted for web browser. No editing from UI.

## Front End

### Pocket

Third party hardware voice recorder. Generates transcripts of audio. Has API and web hook. Plan is to point web hook to agent to receive transcript. May need an adapter.

### PWA (FreeVox) 

Progressive Web App hosted on heroku. RealTime Speech LLM app that facilitates conversation between user and LLM. Creates transcript at end of conversation. In addition to RTS, would be nice to be able to post quick text or voice to text messages. Also would be nice if wired into OS share dialog to send urls or text messages. Maybe this needs to be a native app. 

# Roadmap

* Version 0 \- MVP  
  * Phase 1: Build Data Store  
  * Phase 2: Build Agent   
    * connected to one MCP server  
    * no recording of MCP tool calls to data store  
* Version 1  
  * Phase 3: Improve Agent  
    * Record tool calls to data store  
  * Phase 4: Set up Pocket integration  
* Future Versions  
  * Phase 5: PWA  
  * Phase 6: Search and Archive features in data store UI  
  * Phase 7: Android OS share dialog integration

