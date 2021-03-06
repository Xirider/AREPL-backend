import {PythonShell, Options} from 'python-shell' 

export interface FrameSummary {
	_line: string
	filename: string
	lineno: number
	locals: {}
	name: string
}

export interface UserError{
	__cause__: UserError
	__context__: UserError
	_str: string
	cause: UserError
	context: UserError
	exc_traceback: {}
	exc_type: {
		"py/type": string
	}
	stack: {
		"py/seq": FrameSummary[]
	}
	/* following for syntax errors only */
	filename?: string
	lineno?: string
	msg?: string
	offset?: number
	text?: string
}

export interface ExecArgs{
	evalCode:string,
	savedCode:string,
	filePath:string,
	usePreviousVariables?:boolean,
	showGlobalVars?:boolean,
	default_filter_vars:string[],
	default_filter_types:string[]
}

export interface PythonResult{
	userError: UserError,
	userErrorMsg?: string,
	userVariables:object,
	execTime:number,
	totalPyTime:number,
	totalTime:number,
	internalError:string,
	caller: string,
	lineno:number,
	done: boolean
}

export class PythonEvaluator{
    
    private static readonly identifier = "6q3co7"
	private static readonly areplPythonBackendFolderPath = __dirname + '/python/'

    /**
     * whether python is busy executing inputted code
     */
    executing = false

    /**
     * whether python backend process is running / not running
     */
    running = false

    restarting = false
    private startTime:number

    /**
     * an instance of python-shell. See https://github.com/extrabacon/python-shell
     */
    pyshell:PythonShell

	/**
	 * starts python_evaluator.py 
	 * @param options Process / Python options. If not specified sensible defaults are inferred. 
	 */
	constructor(private options: Options = {}){

		if(process.platform == "darwin"){
			//needed for Mac to prevent ENOENT
			process.env.PATH = ["/usr/local/bin", process.env.PATH].join(":")
		}

		// we want unbuffered mode by default because it can be frustrating to the user
		// if they run the program but don't see any print output immediately.
		if(!options.pythonOptions) this.options.pythonOptions = ['-u']
		if(!options.pythonPath) this.options.pythonPath = PythonShell.defaultPythonPath
		if(!options.scriptPath) this.options.scriptPath = PythonEvaluator.areplPythonBackendFolderPath
	}

	
	/**
	 * does not do anything if program is currently executing code 
	 */
	execCode(code:ExecArgs){
		if(this.executing) return
		this.executing = true
		this.startTime = Date.now()
		this.pyshell.send(JSON.stringify(code))
	}

	/**
	 * @param {string} message
	 */
	sendStdin(message:string){
		this.pyshell.send(message)
	}

	/**
	 * kills python process and restarts.  Force-kills if necessary after 50ms. 
	 * After process restarts the callback passed in is invoked
	 */
	restart(callback=()=>{}){

		this.restarting = false

		// register callback for restart
		// using childProcess callback instead of pyshell callback
		// (pyshell callback only happens when process exits voluntarily)
		this.pyshell.childProcess.on('exit',()=>{
			this.restarting = true
			this.executing = false
			this.start()
			callback()
		})

		this.stop()
	}

	/**
	 * kills python process.  force-kills if necessary after 50ms.
	 * you can check python_evaluator.running to see if process is dead yet
	 */
	stop(){
		// pyshell has 50 ms to die gracefully
		this.pyshell.childProcess.kill()
		this.running = !this.pyshell.childProcess.killed
		if(this.running) console.info("pyshell refused to die")
		else this.executing = false

		setTimeout(()=>{
			if(this.running && !this.restarting){
				// murder the process with extreme prejudice
				this.pyshell.childProcess.kill('SIGKILL')
				if(this.pyshell.childProcess.killed){
					console.error("the python process simply cannot be killed!")
				}
				else this.executing = false
			}
		}, 50)
	}

	/**
	 * starts python_evaluator.py. Will NOT WORK with python 2
	 */
	start(){
		console.log("Starting Python...")
		this.pyshell = new PythonShell('arepl_python_evaluator.py', this.options)
		this.pyshell.on('message', message => {
			this.handleResult(message)
		})
		this.pyshell.on('stderr', (log)=>{
			this.onStderr(log)
		})
		this.running = true
	}

	/**
	 * Overwrite this with your own handler.
	 * is called when program fails or completes
	 */
	onResult(foo: PythonResult){}

	/**
	 * Overwrite this with your own handler.
	 * Is called when program prints
	 * @param {string} foo
	 */
	onPrint(foo: string){}

	/**
	 * Overwrite this with your own handler. 
	 * Is called when program logs stderr
	 * @param {string} foo
	 */
	onStderr(foo: string){}

	/**
	 * handles pyshell results and calls onResult / onPrint
	 * @param {string} results 
	 */
	handleResult(results:string) {
		let pyResult:PythonResult = {
			userError:null,
			userErrorMsg: "",
			userVariables: {},
            execTime:0,
            totalTime:0,
			totalPyTime:0,
			internalError:"",
			caller:"",
			lineno:-1,
			done:true
		}

        //result should have identifier, otherwise it is just a printout from users code
        if(results.startsWith(PythonEvaluator.identifier)){
			try {
				results = results.replace(PythonEvaluator.identifier,"")
				pyResult = JSON.parse(results)
				this.executing = !pyResult['done']
				
				pyResult.execTime = pyResult.execTime*1000 // convert into ms
				pyResult.totalPyTime = pyResult.totalPyTime*1000
				
				//@ts-ignore pyResult.userVariables is sent to as string, we convert to object
				pyResult.userVariables = JSON.parse(pyResult.userVariables)
				//@ts-ignore pyResult.userError is sent to as string, we convert to object
				pyResult.userError = pyResult.userError ? JSON.parse(pyResult.userError) : {}

				if(pyResult.userErrorMsg){
					pyResult.userErrorMsg = this.formatPythonException(pyResult.userErrorMsg)
				}
				pyResult.totalTime = Date.now()-this.startTime
				this.onResult(pyResult)

			} catch (err) {
				if (err instanceof Error){
					err.message = err.message+"\nresults: "+results
				}
				throw err
			}
		}
        else{
            this.onPrint(results)
		}
	}

	/**
	 * checks syntax without executing code
	 * @param {string} code
	 * @returns {Promise} rejects w/ stderr if syntax failure
	 */
	async checkSyntax(code:string){
		return PythonShell.checkSyntax(code);
	}

	/**
	 * checks syntax without executing code
	 * @param {string} filePath
	 * @returns {Promise} rejects w/ stderr if syntax failure
	 */
	async checkSyntaxFile(filePath:string){
		// note that this should really be done in python_evaluator.py
		// but communication with that happens through just one channel (stdin/stdout)
		// so for now i prefer to keep this seperate

		return PythonShell.checkSyntaxFile(filePath);
	}

	/**
	 * gets rid of unnecessary File "<string>" message in exception
	 * @example err:
	 * Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nNameError: name \'x\' is not defined\n
	 */
	formatPythonException(err:string){
		//replace File "<string>" (pointless)
		err = err.replace(/File \"<string>\", /g, "")
		return err
	}

	/**
	 * delays execution of function by ms milliseconds, resetting clock every time it is called
	 * Useful for real-time execution so execCode doesn't get called too often
	 * thanks to https://stackoverflow.com/a/1909508/6629672
	 */
	debounce = (function(){
		let timer:any = 0;
		return function(callback, ms: number, ...args: any[]){
			clearTimeout(timer);
			timer = setTimeout(callback, ms, args);
		};
	})();
}
